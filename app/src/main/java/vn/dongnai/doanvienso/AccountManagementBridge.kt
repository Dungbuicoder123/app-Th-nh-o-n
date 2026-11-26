package vn.dongnai.doanvienso

import android.app.Activity
import android.webkit.JavascriptInterface
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Source
import org.json.JSONArray
import org.json.JSONObject

class AccountManagementBridge(
    private val activity: Activity,
    private val emit: (String, JSONObject) -> Unit
) {
    private val auth get() = FirebaseAuth.getInstance()
    private val db get() = FirebaseFirestore.getInstance()
    private var changingCredentials = false

    @JavascriptInterface
    fun request(uid: String, requestId: Int, operation: String, json: String) = activity.runOnUiThread {
        val reply = JSONObject().put("uid", uid).put("requestId", requestId)
        fun finish(error: Exception? = null) {
            if (auth.currentUser?.uid != uid) return
            if (error != null) {
                val message = when ((error as? FirebaseAuthException)?.errorCode) {
                    "ERROR_WRONG_PASSWORD", "ERROR_INVALID_CREDENTIAL" -> "Mật khẩu hiện tại chưa đúng."
                    "ERROR_EMAIL_ALREADY_IN_USE" -> "Email mới đã được sử dụng."
                    "ERROR_WEAK_PASSWORD" -> "Mật khẩu mới chưa đáp ứng yêu cầu bảo mật."
                    "ERROR_REQUIRES_RECENT_LOGIN" -> "Vui lòng đăng nhập lại rồi đổi thông tin."
                    "ERROR_INVALID_EMAIL" -> "Email chưa đúng định dạng."
                    else -> error.localizedMessage ?: "Chưa hoàn tất thao tác. Vui lòng thử lại."
                }
                reply.put("error", message)
            }
            emit("onManagementResult", reply)
        }
        try {
            val user = auth.currentUser
            require(user != null && user.uid == uid) { "Vui lòng đăng nhập lại." }
            val body = JSONObject(json)
            when (operation) {
                "account" -> user.reload().addOnCompleteListener {
                    if (it.isSuccessful) reply.put("email", user.email.orEmpty())
                        .put("passwordProvider", user.providerData.any { provider -> provider.providerId == "password" })
                    finish(it.exception)
                }
                "email", "password", "resetPassword" -> {
                    check(!changingCredentials) { "Đang xử lý yêu cầu trước." }
                    val email = requireNotNull(user.email)
                    val task = if (operation == "resetPassword") {
                        auth.setLanguageCode("vi")
                        auth.sendPasswordResetEmail(email)
                    } else {
                        val password = body.getString("currentPassword")
                        val value = body.getString("value")
                        require(password.isNotEmpty())
                        require(if (operation == "password") value.length >= 6 else android.util.Patterns.EMAIL_ADDRESS.matcher(value).matches())
                        user.reauthenticate(EmailAuthProvider.getCredential(email, password)).onSuccessTask {
                            check(auth.currentUser?.uid == uid)
                            if (operation == "email") {
                                auth.setLanguageCode("vi")
                                user.verifyBeforeUpdateEmail(value)
                            } else user.updatePassword(value)
                        }
                    }
                    changingCredentials = true
                    task.addOnCompleteListener {
                        changingCredentials = false
                        finish(it.exception)
                    }
                }
                "units" -> {
                    val profile = db.collection("users").document(uid).get(Source.SERVER)
                    profile.onSuccessTask { person ->
                        val home = person.getString("unitCode").orEmpty()
                        val role = person.getString("role")
                        require(role in listOf("bi_thu", "ward_officer"))
                        reply.put("homeUnit", home).put("homeName", person.getString("unitName"))
                            .put("officer", role == "ward_officer")
                        db.collection("registeredUnits").get(Source.SERVER)
                    }.addOnCompleteListener { task ->
                        if (task.isSuccessful) {
                            val home = reply.getString("homeUnit")
                            val units = JSONArray()
                            for (doc in task.result) {
                                if (doc.id == home || reply.getBoolean("officer")) {
                                    units.put(JSONObject(doc.data).put("id", doc.id))
                                }
                            }
                            reply.put("units", units)
                        }
                        finish(task.exception)
                    }
                }
                "saveUnit" -> {
                    val id = body.getString("id")
                    val name = body.getString("name").trim()
                    val address = body.optString("address").trim()
                    val phone = body.optString("contactPhone").trim()
                    require(id.isNotBlank() && id.length <= 100 && '/' !in id && name.length in 1..120 && address.length <= 250)
                    require(phone.isEmpty() || phone.matches(Regex("0[0-9]{9,10}")))
                    val ref = db.collection("registeredUnits").document(id)
                    db.runTransaction { tx ->
                        val person = tx.get(db.collection("users").document(uid))
                        val current = tx.get(ref)
                        val home = person.getString("unitCode")
                        val officer = person.getString("role") == "ward_officer"
                        require(person.getString("role") in listOf("bi_thu", "ward_officer"))
                        require(id == home || officer)
                        require(current.exists() || id.matches(Regex("[A-Za-z0-9]{20}")))
                        val fields = mutableMapOf<String, Any>("name" to name, "address" to address, "contactPhone" to phone)
                        if (id != home && !current.exists()) fields["parentUnitCode"] = requireNotNull(home)
                        tx.set(ref, fields, com.google.firebase.firestore.SetOptions.merge())
                    }.addOnCompleteListener { finish(it.exception) }
                }
                else -> error("Thao tác không hợp lệ.")
            }
        } catch (e: Exception) { finish(e) }
    }
}
