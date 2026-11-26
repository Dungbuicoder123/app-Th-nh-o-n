package vn.dongnai.doanvienso

import android.app.Activity
import android.webkit.JavascriptInterface
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.Query

import org.json.JSONArray
import org.json.JSONObject
import java.util.Date

import java.util.concurrent.TimeUnit

/** All listener and session state is owned by the activity's main thread. */
class UnitWorkBridge(private val activity: Activity, private val emit: (String, JSONObject) -> Unit) {
    private val db by lazy { FirebaseFirestore.getInstance() }
    private val auth by lazy { FirebaseAuth.getInstance() }
    private val listeners = mutableListOf<ListenerRegistration>()
    private var session = 0
    private var uid = ""
    private var unit = ""
    private val root get() = db.collection("unitWork").document(unit)

    fun close() {
        session++
        listeners.forEach { it.remove() }
        listeners.clear()
        uid = ""
        unit = ""
    }

    @JavascriptInterface
    fun start(user: String, code: String, manager: Boolean, officer: Boolean) = activity.runOnUiThread {
        close()
        if (auth.currentUser?.uid != user || code.isBlank() || '/' in code) return@runOnUiThread
        uid = user
        unit = code
        listen("counts", root.collection("statistics").whereEqualTo(com.google.firebase.firestore.FieldPath.documentId(), "members"))
        listen("unit", db.collection("registeredUnits").whereEqualTo(com.google.firebase.firestore.FieldPath.documentId(), code))
        listen("events", root.collection("events"))
        for (name in listOf("receipts", "evidence", "profileRequests", "applications", "awards", "feedback")) {
            val source = root.collection(name)
            listen(name, if (manager) source else source.whereEqualTo("owner", user))
        }
        listen("self", db.collection("users").whereEqualTo(com.google.firebase.firestore.FieldPath.documentId(), user))
        if (officer) listen("secretaries", db.collection("users").whereEqualTo("unitCode", code).whereEqualTo("role", "bi_thu"))
        if (manager) {
            listen("roster", root.collection("roster"))
            listen("keys", root.collection("keys"))
            listen("people", db.collection("users").whereEqualTo("role", "doan_vien").whereEqualTo("unitCode", code))
        }
    }

    private fun listen(name: String, query: Query) {
        val generation = session
        listeners += query.addSnapshotListener(MetadataChanges.INCLUDE) { snapshot, error ->
            if (generation != session || uid != auth.currentUser?.uid) return@addSnapshotListener
            val result = JSONObject().put("uid", uid).put("unitCode", unit).put("channel", name)
            if (error != null) result.put("error", message(error))
            else if (snapshot != null) {
                if (snapshot.metadata.hasPendingWrites()) return@addSnapshotListener
                if (snapshot.metadata.isFromCache) {
                    emit("onUnitSnapshot", result.put("offline", true))
                    return@addSnapshotListener
                }
                val rows = JSONArray()
                for (doc in snapshot) {
                    val row = JSONObject()
                    if (name in setOf("people", "self", "secretaries")) {
                        row.put("details", JSONObject.wrap(doc.get("details") ?: emptyMap<String,String>()))
                        row.put("unit", doc.get("unitName") as? String ?: "")
                        row.put("name", doc.get("displayName") as? String ?: "")
                        row.put("phone", doc.get("phone") as? String ?: "")
                    } else for ((field, value) in doc.data) {
                        row.put(field, if (value is Timestamp) value.toDate().time else JSONObject.wrap(value))
                    }
                    rows.put(row.put("id", doc.id))
                }
                result.put("rows", rows)
            }
            emit("onUnitSnapshot", result)
        }
    }

    private fun profileUpdates(changes: Map<String, String>): Map<String, Any> {
        val allowed = setOf("name", "birthDate", "ethnicity", "religion", "cardNo", "citizenId", "address", "unit", "status", "phone")
        require(changes.isNotEmpty() && allowed.containsAll(changes.keys)) { "Thông tin cập nhật hồ sơ không hợp lệ." }
        return changes.mapKeys { (key, _) -> when (key) { "name" -> "displayName"; "phone" -> "phone"; else -> "details.$key" } }
    }

    private fun message(error: Exception): String = when ((error as? FirebaseFirestoreException)?.code) {
        FirebaseFirestoreException.Code.PERMISSION_DENIED -> "Firestore từ chối thao tác. Kiểm tra đơn vị, hạn điểm danh, mã QR và quyền đã triển khai."
        FirebaseFirestoreException.Code.UNAVAILABLE -> "Chưa kết nối được Firestore."
        else -> error.localizedMessage ?: "Chưa đồng bộ được dữ liệu."
    }

    @JavascriptInterface
    fun submit(user: String, requestId: Int, operation: String, data: String) = activity.runOnUiThread {
        val generation = session
        val reply = JSONObject().put("uid", user).put("requestId", requestId)
        fun finish(error: Exception?) {
            if (generation == session) {
                if (error != null) reply.put("error", message(error))
                emit("onUnitWrite", reply)
            }
        }
        try {
            require(uid == user && auth.currentUser?.uid == user && unit.isNotBlank())
            val body = JSONObject(data)
            val id = body.getString("id")
            require(id.matches(Regex("[a-zA-Z0-9_-]{1,100}")))
            val event = root.collection("events").document(id)
            val proof = root.collection("evidence").document(id)
            val task: Task<*> = when (operation) {
                "publish", "publishLegacy" -> {
                    val kind = body.getString("kind")
                    val fields = mapOf("kind" to kind, "content" to body.getJSONObject("content").toString(),
                        "deadline" to Timestamp(Date(body.optLong("deadline"))), "points" to body.optInt("points"),
                        "capacity" to body.optInt("capacity"), "booked" to 0)
                    if (operation == "publishLegacy") {
                        require(kind == "news" || kind == "register")
                        db.runTransaction { tx ->
                            if (!tx.get(event).exists()) tx.set(event, fields)
                        }
                    } else if (kind == "news") {
                        db.runTransaction { tx ->
                            val existing = tx.get(event)
                            if (!existing.exists()) tx.set(event, fields)
                            else require(existing.getString("content") == fields["content"]) {
                                "Bài viết này đã được đăng. Đóng cửa sổ và xem lại bảng tin."
                            }
                        }
                    } else {
                        val batch = db.batch().set(event, fields)
                        if (kind == "meeting") batch.set(root.collection("keys").document(id), mapOf("code" to body.getString("code")))
                        batch.commit()
                    }
                }
                "importRoster", "migrateRoster" -> {
                    val records = body.getJSONArray("records")
                    require(records.length() in 1..200)
                    val batch = db.batch()
                    val entries = (0 until records.length()).map { index ->
                        val row = records.getJSONObject(index)
                        val phone = row.getString("phone")
                        require(phone.matches(Regex("0[0-9]{9,10}")))
                        val fields = listOf("name", "phone", "group", "job", "shift", "status").associateWith { row.optString(it) }
                        root.collection("roster").document(phone) to (fields + ("birthYear" to row.optInt("birthYear")))
                    }
                    if (operation == "migrateRoster") db.runTransaction { tx ->
                        val missing = entries.filter { !tx.get(it.first).exists() }
                        missing.forEach { (ref, fields) -> tx.set(ref, fields) }
                    } else {
                        entries.forEach { (ref, fields) -> batch.set(ref, fields, com.google.firebase.firestore.SetOptions.merge()) }
                        batch.commit()
                    }
                }
                "editRoster" -> {
                    val raw = body.getJSONObject("changes")
                    val changes = raw.keys().asSequence().associateWith { raw.getString(it) }
                    require("phone" !in changes)
                    val updates = profileUpdates(changes).mapKeys { (key, _) ->
                        when (key) { "displayName" -> "name"; "details.status" -> "status"; else -> key }
                    }
                    root.collection("roster").document(id).update(updates)
                }
                "countMembers" -> root.collection("statistics").document("members").set(
                    listOf("total","local","far","transfer").associateWith { body.getInt(it) })
                "feedback" -> {
                    require(id.matches(Regex("[a-f0-9]{24}")))
                    val title = body.getString("title").trim()
                    val content = body.getString("body").trim()
                    require(title.isNotBlank() && title.length <= 120 && content.isNotBlank() && content.length <= 4000) {
                        "Tiêu đề tối đa 120 ký tự và nội dung tối đa 4.000 ký tự."
                    }
                    val ref = root.collection("feedback").document(id)
                    db.runTransaction { tx ->
                        val existing = tx.get(ref)
                        if (existing.exists()) {
                            require(existing.getString("owner") == user && existing.getString("title") == title &&
                                existing.getString("body") == content) { "Góp ý đã được gửi với nội dung khác. Hãy tải lại danh sách." }
                        } else {
                            val profile = tx.get(db.collection("users").document(user))
                            tx.set(ref, mapOf("owner" to user, "name" to (profile.getString("displayName") ?: ""),
                                "title" to title, "body" to content, "status" to "pending", "at" to FieldValue.serverTimestamp()))
                        }
                    }
                }
                "receiveFeedback" -> {
                    val ref = root.collection("feedback").document(id)
                    db.runTransaction { tx ->
                        val current = tx.get(ref)
                        require(current.exists()) { "Không tìm thấy góp ý." }
                        if (current.getString("status") == "pending")
                            tx.update(ref, "status", "received", "receivedBy", user, "receivedAt", FieldValue.serverTimestamp())
                    }
                }
                "award" -> root.collection("awards").document(id).set(
                    listOf("owner", "memberName", "title", "level").associateWith { body.getString(it) } +
                        mapOf("points" to body.getInt("points"), "at" to FieldValue.serverTimestamp()))
                "claim" -> {
                    val owner = body.optString("owner", user)
                    require(owner.isNotBlank() && '/' !in owner)
                    val receipt = root.collection("receipts").document(id + "~" + owner)
                    receipt.set(mapOf("owner" to owner, "event" to id, "code" to body.optString("code"),
                        "at" to FieldValue.serverTimestamp()))
                }
                "book" -> {
                    val receipt = root.collection("receipts").document(id + "~" + user)
                    val reserve = body.getBoolean("reserve")
                    db.runTransaction { tx ->
                        val current = tx.get(event)
                        if (tx.get(receipt).exists() != reserve) {
                            val booked = current.getLong("booked") ?: 0
                            if (reserve) {
                                require(booked < (current.getLong("capacity") ?: 0)) { "Buổi bù đã hết chỗ." }
                                tx.set(receipt, mapOf("owner" to user, "event" to id, "code" to "", "at" to FieldValue.serverTimestamp()))
                            } else tx.delete(receipt)
                            tx.update(event, "booked", booked + if (reserve) 1 else -1)
                        }
                    }
                }
                "evidence" -> proof.set(mapOf("owner" to user, "event" to body.getString("event"),
                    "name" to body.getString("name"), "description" to body.getString("description"),
                    "image" to body.optString("image"), "link" to body.optString("link"),
                    "status" to "pending", "at" to FieldValue.serverTimestamp()))
                "profileRequest", "editPerson" -> {
                    val dataFields = body.getJSONObject("changes")
                    val changes = dataFields.keys().asSequence().associateWith { dataFields.getString(it) }
                    val updates = profileUpdates(changes)
                    if (operation == "editPerson") {
                        val batch = db.batch().update(db.collection("users").document(id), updates)
                        val rosterPhone = body.optString("rosterPhone")
                        if (rosterPhone.matches(Regex("0[0-9]{9,10}"))) batch.update(root.collection("roster").document(rosterPhone), "accountUid", id)
                        batch.commit()
                    }
                    else {
                        require(id == user)
                        root.collection("profileRequests").document(id).set(mapOf("owner" to user,
                            "changes" to changes, "version" to body.getString("version"), "status" to "pending",
                            "at" to FieldValue.serverTimestamp()))
                    }
                }
                "reviewProfile" -> db.runTransaction { tx ->
                    val ref = root.collection("profileRequests").document(id)
                    val request = tx.get(ref)
                    require(request.getString("version") == body.getString("version") && request.getString("status") == "pending") {
                        "Yêu cầu đã thay đổi. Vui lòng xem lại."
                    }
                    val accepted = body.getBoolean("approve")
                    if (accepted) {
                        val changes = (request.get("changes") as Map<*, *>).entries.associate { it.key as String to it.value as String }
                        tx.update(db.collection("users").document(id), profileUpdates(changes))
                        val phone = body.optString("rosterPhone")
                        if (phone.matches(Regex("0[0-9]{9,10}"))) tx.update(root.collection("roster").document(phone), "accountUid", id)
                    }
                    tx.update(ref, "status", if (accepted) "approved" else "rejected", "at", FieldValue.serverTimestamp())
                }
                "apply" -> {
                    val fields = listOf("event","profileCode","submitterName","unitName","registrationType","notes","phone")
                        .associateWith { body.getString(it) }
                    root.collection("applications").document(id).set(fields + mapOf("owner" to user,
                        "status" to "pending", "rejectReason" to "", "at" to FieldValue.serverTimestamp()))
                }
                "decide" -> root.collection("applications").document(id).update("status", body.getString("status"),
                    "rejectReason", body.optString("reason"), "decidedAt", FieldValue.serverTimestamp())
                "withdraw" -> root.collection("applications").document(id).delete()
                "review" -> proof.update("status", body.getString("status"))
                else -> error("Thao tác không hợp lệ.")
            }
            Tasks.withTimeout(task, 20, TimeUnit.SECONDS).addOnCompleteListener { finish(it.exception) }
        } catch (e: Exception) { finish(e) }
    }
}
