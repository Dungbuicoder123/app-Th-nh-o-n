package vn.dongnai.doanvienso

import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.google.firebase.storage.UploadTask
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class NewsAttachmentsBridge(private val activity: AppCompatActivity, private val emit: (String, JSONObject) -> Unit) {
    private data class Attachment(val id: String, val name: String, val type: String, val file: File) {
        fun json() = JSONObject().put("id", id).put("name", name).put("type", type).put("size", file.length())
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val files = mutableListOf<Attachment>()
    private lateinit var picker: ActivityResultLauncher<Array<String>>
    private var draft = ""
    private var uid = ""
    private var busy = false
    @Volatile private var generation = 0
    @Volatile private var upload: UploadTask? = null
    private val uploaded = mutableMapOf<String, String>()
    private val auth get() = FirebaseAuth.getInstance()

    fun register() {
        picker = activity.registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            if (worker.isShutdown) return@registerForActivityResult
            val token = generation
            val remaining = 5 - files.size
            worker.execute {
                val added = mutableListOf<Attachment>()
                var error: String? = null
                try {
                    require(uris.size <= remaining) { "Mỗi bài tối đa 5 tệp." }
                    for (uri in uris) added += copyAttachment(uri)
                } catch (e: Exception) {
                    added.forEach { it.file.delete() }
                    added.clear()
                    error = e.message ?: "Không đọc được tệp."
                }
                activity.runOnUiThread {
                    if (generation != token) {
                        added.forEach { it.file.delete() }
                    } else {
                        files.addAll(added)
                        busy = false
                        deliverSelection(error)
                    }
                }
            }
        }
    }

    private fun copyAttachment(uri: Uri): Attachment {
        require(uri.scheme == "content")
        val resolver = activity.contentResolver
        val type = resolver.getType(uri).orEmpty()
        val allowed = type in setOf("image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
            "application/pdf", "text/plain", "application/msword", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        require(allowed) { "Chọn ảnh JPG/PNG/WebP, video MP4/WebM, PDF, Word, Excel hoặc TXT." }
        var name = "Tệp đính kèm"
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) name = it.getString(0).take(180)
        }
        val file = File.createTempFile("news-", ".upload", activity.cacheDir)
        val limit = if (type.startsWith("video/")) 50L * 1024 * 1024 else 20L * 1024 * 1024
        try {
            requireNotNull(resolver.openInputStream(uri)).use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= limit) { "Video tối đa 50 MB, các tệp khác tối đa 20 MB." }
                        output.write(buffer, 0, count)
                    }
                    require(total > 0) { "Tệp được chọn đang trống." }
                }
            }
            return Attachment(UUID.randomUUID().toString(), name, type, file)
        } catch (e: Exception) {
            file.delete()
            throw e
        }
    }

    private fun deliverSelection(error: String? = null) {
        if (auth.currentUser?.uid != uid) return
        val result = JSONObject().put("uid", uid).put("draft", draft)
            .put("files", JSONArray(files.map { it.json() }))
        if (error != null) result.put("error", error)
        emit("onNewsSelection", result)
    }

    @JavascriptInterface
    fun select(user: String, draftId: String) = activity.runOnUiThread {
        if (auth.currentUser?.uid != user || busy || !draftId.matches(Regex("[a-f0-9]{24}"))) return@runOnUiThread
        if (draft != draftId || uid != user) close()
        uid = user
        draft = draftId
        if (files.size >= 5) return@runOnUiThread deliverSelection("Mỗi bài tối đa 5 tệp.")
        busy = true
        try { picker.launch(arrayOf("image/*", "video/mp4", "video/webm", "application/pdf", "text/plain",
            "application/msword", "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")) }
        catch (e: Exception) { busy = false; deliverSelection("Không mở được trình chọn tệp.") }
    }

    @JavascriptInterface
    fun remove(user: String, draftId: String, id: String) = activity.runOnUiThread {
        if (busy || user != uid || auth.currentUser?.uid != user || draft != draftId) return@runOnUiThread
        val item = files.find { it.id == id } ?: return@runOnUiThread
        files.remove(item)
        worker.execute {
            item.file.delete()
            uploaded.keys.filter { it.endsWith("/" + id) }.toList().forEach { path ->
                FirebaseStorage.getInstance().reference.child(path).delete()
                uploaded.remove(path)
            }
        }
        deliverSelection()
    }

    @JavascriptInterface
    fun upload(user: String, unit: String, draftId: String, requestId: Int) = activity.runOnUiThread {
        val reply = JSONObject().put("uid", user).put("requestId", requestId)
        if (auth.currentUser?.uid != user || busy || draft != draftId || uid != user ||
            !unit.matches(Regex("[A-Za-z0-9]{20}"))) {
            emit("onManagementResult", reply.put("error", "Tệp chưa sẵn sàng. Vui lòng chọn lại."))
            return@runOnUiThread
        }
        busy = true
        val token = generation
        val selected = files.toList()
        worker.execute {
            try {
                val results = JSONArray()
                for ((index, item) in selected.withIndex()) {
                    check(generation == token && auth.currentUser?.uid == user)
                    val path = "newsAttachments/$unit/$draftId/${item.id}"
                    var url = uploaded[path]
                    if (url == null) {
                        val ref = FirebaseStorage.getInstance().reference.child(path)
                        try {
                            url = Tasks.await(ref.downloadUrl, 30, TimeUnit.SECONDS).toString()
                        } catch (e: Exception) {
                            val cause = e.cause ?: e
                            if ((cause as? StorageException)?.errorCode != StorageException.ERROR_OBJECT_NOT_FOUND) throw e
                        }
                        if (url != null) {
                            uploaded[path] = url
                            results.put(item.json().put("url", url))
                            continue
                        }
                        val task = ref.putFile(Uri.fromFile(item.file), StorageMetadata.Builder().setContentType(item.type).build())
                        upload = task
                        task.addOnProgressListener { progress ->
                            if (generation == token) emit("onNewsUploadProgress", JSONObject().put("uid", user)
                                .put("draft", draftId).put("index", index + 1)
                                .put("percent", 100 * progress.bytesTransferred / progress.totalByteCount.coerceAtLeast(1)))
                        }
                        if (generation != token) { task.cancel(); error("Phiên đã thay đổi.") }
                        try {
                            Tasks.await(task, 3, TimeUnit.MINUTES)
                            url = Tasks.await(ref.downloadUrl, 30, TimeUnit.SECONDS).toString()
                        } catch (e: Exception) { task.cancel(); throw e }
                        uploaded[path] = url
                    }
                    results.put(item.json().put("url", url))
                }
                reply.put("attachments", results)
            } catch (e: Exception) {
                reply.put("error", "Chưa tải xong tệp. Kiểm tra kết nối và cấu hình lưu trữ, rồi thử lại.")
            }
            activity.runOnUiThread {
                if (generation == token) {
                    busy = false
                    upload = null
                    emit("onManagementResult", reply)
                }
            }
        }
    }

    @JavascriptInterface
    fun discard(user: String, draftId: String, published: Boolean) = activity.runOnUiThread {
        if (auth.currentUser?.uid == user && uid == user && draft == draftId && !busy) {
            if (!published) worker.execute {
                uploaded.keys.forEach { path -> FirebaseStorage.getInstance().reference.child(path).delete() }
            }
            close()
        }
    }

    fun destroy() {
        close()
        worker.shutdown()
    }

    fun close() {
        generation++
        upload?.cancel()
        upload = null
        busy = false
        val old = files.toList()
        files.clear()
        worker.execute { old.forEach { it.file.delete() }; uploaded.clear() }
        uid = ""
        draft = ""
    }
}
