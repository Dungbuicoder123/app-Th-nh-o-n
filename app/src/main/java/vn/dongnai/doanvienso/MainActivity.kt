package vn.dongnai.doanvienso

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInAccount
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.AuthResult
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.FirebaseNetworkException
import com.google.firebase.FirebaseTooManyRequestsException
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Source
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

class MainActivity : AppCompatActivity() {

    private val accountManagement by lazy { AccountManagementBridge(this, ::deliverFirebase) }
    private val newsAttachments by lazy { NewsAttachmentsBridge(this, ::deliverFirebase) }
    private val unitWork by lazy { UnitWorkBridge(this, ::deliverFirebase) }
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val fileWriter = Executors.newSingleThreadExecutor()
    private var pendingDocument: File? = null
    private var preparingPrint: WebView? = null
    private var pageReady = false
    private var scanning = false
    private var pendingScanJson: String? = null


    private val db by lazy { FirebaseFirestore.getInstance() }
    private val auth by lazy { FirebaseAuth.getInstance() }

    // Accessed on the main thread. A timed-out SDK request can still change currentUser.
    private var pendingAuth: Task<AuthResult>? = null

    private fun <T> Task<T>.withNetworkDeadline(): Task<T> =
        Tasks.withTimeout(this, 15, TimeUnit.SECONDS)

    private fun authenticate(
        registering: Boolean = false,
        request: () -> Task<AuthResult>,
        onSuccess: (AuthResult) -> Unit
    ) {
        if (pendingAuth?.isComplete == false) {
            loginError("Firebase vẫn đang xử lý yêu cầu trước. Vui lòng thử lại sau.")
            return
        }
        if (getSystemService(ConnectivityManager::class.java).activeNetwork == null) {
            loginError("Thiết bị chưa có kết nối mạng. Kết nối lại rồi thử lại.")
            return
        }
        try {
            val task = request().withNetworkDeadline()
            pendingAuth = task
            task.addOnSuccessListener(onSuccess)
                .addOnFailureListener { loginError(authMessage(it, registering)) }
                .addOnCompleteListener { pendingAuth = null }
        } catch (e: Exception) {
            pendingAuth = null
            loginError(authMessage(e, registering))
        }
    }

    private val googleSignInLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->

        val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
        try {
            val account: GoogleSignInAccount = task.getResult(ApiException::class.java)
            val idToken = account.idToken
            if (idToken.isNullOrBlank()) {
                loginError("Chưa xác thực được tài khoản Google.")
            } else {
                authenticate(request = { auth.signInWithCredential(GoogleAuthProvider.getCredential(idToken, null)) }) {
                    loadFirebaseProfile()
                }
            }
        } catch (e: Exception) {
            loginError("Đăng nhập Google đã bị hủy hoặc không thành công.")
        }
    }

    private fun deliverLogin(result: JSONObject) = deliverFirebase("onFirebaseLogin", result)

    private fun deliverFirebase(callback: String, result: JSONObject) = runOnUiThread {
        if (!isDestroyed && !isFinishing) {
            webView.evaluateJavascript("window.App && App.$callback($result)", null)
        }
    }

    private fun loginError(message: String) {
        deliverLogin(JSONObject().put("success", false).put("error", message))
    }

    private fun authMessage(error: Exception, registering: Boolean): String {
        if (error is TimeoutException) return if (registering)
            "Firebase chưa xác nhận việc tạo tài khoản. Kiểm tra mạng rồi thử đăng nhập bằng email vừa dùng."
        else "Firebase chưa phản hồi yêu cầu đăng nhập. Kiểm tra mạng rồi thử lại."
        if (error is FirebaseNetworkException) return "Không kết nối được Firebase. Kiểm tra mạng rồi thử lại."
        if (error is FirebaseTooManyRequestsException) return "Có quá nhiều yêu cầu. Vui lòng chờ rồi thử lại."
        return when ((error as? FirebaseAuthException)?.errorCode) {
            "ERROR_EMAIL_ALREADY_IN_USE" -> "Email đã có tài khoản. Hãy đăng nhập bằng email để tiếp tục."
            "ERROR_WEAK_PASSWORD" -> "Mật khẩu chưa đáp ứng yêu cầu của đơn vị."
            "ERROR_INVALID_EMAIL" -> "Địa chỉ email chưa đúng định dạng."
            "ERROR_USER_DISABLED" -> "Tài khoản đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên."
            "ERROR_OPERATION_NOT_ALLOWED", "ERROR_ADMIN_RESTRICTED_OPERATION" ->
                "Dự án chưa cho phép thao tác email này. Quản trị viên cần kiểm tra Firebase Authentication."
            "ERROR_INVALID_CREDENTIAL", "ERROR_WRONG_PASSWORD", "ERROR_USER_NOT_FOUND" ->
                "Email hoặc mật khẩu chưa đúng."
            else -> if (registering) "Chưa tạo được tài khoản. Vui lòng thử lại." else "Chưa đăng nhập được. Vui lòng thử lại."
        }
    }

    private fun firestoreMessage(error: Exception, action: String): String =
        when ((error as? FirebaseFirestoreException)?.code) {
            FirebaseFirestoreException.Code.PERMISSION_DENIED -> "Firestore từ chối quyền $action. Liên hệ quản trị viên để kiểm tra quy tắc của đơn vị."
            FirebaseFirestoreException.Code.UNAVAILABLE, FirebaseFirestoreException.Code.DEADLINE_EXCEEDED ->
                "Firestore chưa cho phép ứng dụng $action hoặc dịch vụ chưa sẵn sàng. Nếu mạng hoạt động, liên hệ quản trị viên để kiểm tra Cloud Firestore của dự án."
            FirebaseFirestoreException.Code.UNAUTHENTICATED -> "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."
            else -> if (error is TimeoutException) "Firestore chưa phản hồi khi $action. Kiểm tra mạng rồi thử lại."
                else "Chưa thể $action. Vui lòng thử lại."
        }

    private fun loadFirebaseProfile() {
        val user = auth.currentUser ?: return loginError("Vui lòng đăng nhập lại.")
        deliverFirebase("onFirebaseProfileLoading", JSONObject())
        db.collection("users").document(user.uid).get(Source.SERVER).withNetworkDeadline()
            .addOnSuccessListener { doc ->
                if (auth.currentUser?.uid != user.uid) return@addOnSuccessListener
                if (!doc.exists()) {
                    deliverLogin(JSONObject().put("needsProfile", true).put("uid", user.uid))
                    return@addOnSuccessListener
                }
                val role = doc.get("role") as? String
                val unitCode = (doc.get("unitCode") as? String).orEmpty().trim()
                val unitName = (doc.get("unitName") as? String).orEmpty().trim()
                if (role !in setOf("doan_vien", "bi_thu", "ward_officer") || unitCode.isEmpty() || unitName.isEmpty()) {
                    loginError("Đơn vị chưa cấp vai trò hoặc thông tin chi đoàn cho tài khoản này.")
                    return@addOnSuccessListener
                }
                deliverLogin(JSONObject().put("success", true).put("uid", user.uid)
                    .put("role", role).put("unitCode", unitCode).put("unitName", unitName)
                    .put("phone", (doc.get("phone") as? String).orEmpty())
                    .put("displayName", doc.get("displayName") as? String ?: user.displayName ?: user.email.orEmpty()))
            }
            .addOnFailureListener { error ->
                if (auth.currentUser?.uid == user.uid) {
                    deliverLogin(JSONObject().put("retryProfile", true)
                        .put("error", firestoreMessage(error, "tải hồ sơ")))
                }
            }
    }

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        scanning = false
        val scanContent = result.contents
        pendingScanJson = scanContent?.let(JSONObject::quote) ?: "null"


        deliverScanResult()
    }


    private fun deliverScanResult() {
        val json = pendingScanJson ?: return
        if (!pageReady) return
        pendingScanJson = null
        webView.evaluateJavascript("window.App && window.App.onQrScanResult && window.App.onQrScanResult($json)", null)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deliverArticleLink()
    }

    private fun deliverArticleLink() {
        if (!pageReady || intent.action != Intent.ACTION_VIEW) return
        val uri = intent.data ?: return
        val path = uri.pathSegments
        if (uri.scheme != "doanvienso" || uri.host != "news" || path.size != 2 ||
            path[0].isBlank() || path[0].length > 128 || !path[1].matches(Regex("[a-zA-Z0-9_-]{1,100}"))) return
        deliverFirebase("onArticleLink", JSONObject().put("unit", path[0]).put("id", path[1]))
        intent.data = null
    }

    private fun notifyUser(message: String) = runOnUiThread {
        Toast.makeText(applicationContext, message, Toast.LENGTH_LONG).show()
    }

    private val saveFileLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val file = pendingDocument ?: return@registerForActivityResult
        pendingDocument = null
        val uri = result.data?.data
        fileWriter.execute {
            try {
                if (result.resultCode == Activity.RESULT_OK && uri != null) {
                    checkNotNull(contentResolver.openOutputStream(uri)).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                    }
                    notifyUser("Đã lưu tệp")
                }
            } catch (e: Exception) {
                notifyUser("Không thể lưu tệp: ${e.message}")
            } finally {
                file.delete()
            }
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null

        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            callback.onReceiveValue(null)
            return@registerForActivityResult
        }

        val data = result.data!!
        val uris = mutableListOf<Uri>()
        val clipData = data.clipData
        if (clipData != null) {
            for (i in 0 until clipData.itemCount) {
                clipData.getItemAt(i)?.uri?.let { uris.add(it) }
            }
        } else {
            data.data?.let { uris.add(it) }
        }
        val selected = uris.filter { it.scheme == "content" }.distinct()
        callback.onReceiveValue(selected.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (NEWS_ATTACHMENTS_ENABLED) newsAttachments.register()
        pendingDocument = savedInstanceState?.getString("exportFile")?.let { File(cacheDir, it) }
        scanning = savedInstanceState?.getBoolean("scanning") == true
        pendingScanJson = savedInstanceState?.getString("scanResult")

        webView = WebView(this)
        if (Build.HARDWARE in setOf("ranchu", "goldfish")) {
            webView.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        }
        setContentView(webView)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }

        webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")
        webView.addJavascriptInterface(unitWork, "UnitWork")
        webView.addJavascriptInterface(accountManagement, "AccountManagement")
        if (NEWS_ATTACHMENTS_ENABLED) webView.addJavascriptInterface(newsAttachments, "NewsAttachments")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.toString() == APP_URL) return false
                if (url.scheme == "http" || url.scheme == "https") {
                    try {
                        startActivity(Intent(Intent.ACTION_VIEW, url))
                    } catch (_: Exception) {}
                }
                return true
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                val response = assetLoader.shouldInterceptRequest(request.url)
                if (response != null && request.url.toString() == APP_URL) {
                    response.responseHeaders = (response.responseHeaders.orEmpty() + (
                        "Content-Security-Policy" to "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
                    ))
                }
                return response
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                if (url == APP_URL) {
                    pageReady = true
                    view?.evaluateJavascript("document.body.classList.add('is-android-app');", null)
                    deliverScanResult()
                    deliverArticleLink()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    val acceptedTypes = fileChooserParams?.acceptTypes.orEmpty()
                        .flatMap { it.split(',') }
                        .map(String::trim)
                        .filter { it.contains('/') }
                        .distinct()
                    type = acceptedTypes.singleOrNull() ?: "*/*"
                    if (acceptedTypes.size > 1) {
                        putExtra(Intent.EXTRA_MIME_TYPES, acceptedTypes.toTypedArray())
                    }
                    putExtra(
                        Intent.EXTRA_ALLOW_MULTIPLE,
                        fileChooserParams?.mode == FileChooserParams.MODE_OPEN_MULTIPLE
                    )
                }
                return try {
                    fileChooserLauncher.launch(Intent.createChooser(intent, "Chọn tệp đính kèm"))
                    true
                } catch (e: Exception) {
                    this@MainActivity.filePathCallback = null
                    false
                }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("Boolean(window.App && App.handleBack && App.handleBack())") { handled ->
                    if (handled != "true" && !isFinishing && !isDestroyed) finish()
                }
            }
        })

        webView.loadUrl(APP_URL)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString("exportFile", pendingDocument?.name)
        outState.putBoolean("scanning", scanning)
        outState.putString("scanResult", pendingScanJson)
    }

    override fun onDestroy() {
        if (NEWS_ATTACHMENTS_ENABLED) newsAttachments.destroy()
        unitWork.close()
        fileWriter.shutdown()
        preparingPrint?.destroy()
        preparingPrint = null
        if (isFinishing) pendingDocument?.delete()
        (webView.parent as? ViewGroup)?.removeView(webView)
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        webView.stopLoading()
        webView.removeJavascriptInterface("AndroidBridge")
        webView.destroy()
        super.onDestroy()
    }


    inner class AndroidBridge {
        @JavascriptInterface
        fun copyArticleLink(link: String) = runOnUiThread {
            if (Uri.parse(link).scheme == "doanvienso" && Uri.parse(link).host == "news") {
                getSystemService(android.content.ClipboardManager::class.java)
                    .setPrimaryClip(android.content.ClipData.newPlainText("Bài viết Đoàn Viên Số", link))
            }
        }
        @JavascriptInterface
        fun openArticleChat(prompt: String) {
            runOnUiThread {
                val uri = Uri.parse("https://chatgpt.com/").buildUpon()
                    .appendQueryParameter("q", prompt).build()
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (e: android.content.ActivityNotFoundException) {
                    notifyUser("Thiết bị chưa có trình duyệt để mở ChatGPT.")
                }
            }
        }

        @JavascriptInterface
        fun scanQr() = runOnUiThread {
            if (isFinishing || isDestroyed || scanning) return@runOnUiThread
            try {
                scanning = true
                scanner.launch(ScanOptions().apply {
                    setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    setPrompt("Đặt mã QR điểm danh vào khung hình")
                    setBeepEnabled(false)
                    setOrientationLocked(false)
                })
            } catch (e: Exception) {
                scanning = false
                pendingScanJson = "null"
                deliverScanResult()
                notifyUser("Không thể mở máy quét QR")
            }
        }

        @JavascriptInterface
        fun printHtml(htmlContent: String, jobName: String) {
            runOnUiThread {
                if (isFinishing || isDestroyed || preparingPrint != null) return@runOnUiThread
                val printWebView = WebView(this@MainActivity)
                preparingPrint = printWebView
                printWebView.settings.apply {
                    allowFileAccess = false
                    allowContentAccess = false
                    blockNetworkLoads = true
                }
                printWebView.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) {
                        if (preparingPrint !== view || isFinishing || isDestroyed) return
                        preparingPrint = null
                        val printManager =
                            getSystemService(Context.PRINT_SERVICE) as PrintManager
                        val adapter = view.createPrintDocumentAdapter(jobName)
                        try {
                            printManager.print(
                                jobName,
                                adapter,
                                PrintAttributes.Builder()
                                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
                                    .build()
                            )
                        } catch (e: Exception) {
                            view.destroy()
                            notifyUser("Không thể mở hộp thoại in: ${e.message}")
                        }
                    }
                }
                printWebView.loadDataWithBaseURL(null, htmlContent, "text/html", "UTF-8", null)
            }
        }

        @JavascriptInterface
        fun saveBase64File(base64Data: String, fileName: String, mimeType: String) {
            try {
                val bytes = Base64.decode(base64Data.substringAfter("base64,", base64Data), Base64.DEFAULT)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                        put(MediaStore.Downloads.MIME_TYPE, mimeType)
                        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
                        put(MediaStore.Downloads.IS_PENDING, 1)
                    }
                    val uri = checkNotNull(contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values))
                    try {
                        checkNotNull(contentResolver.openOutputStream(uri)).use { it.write(bytes) }
                        values.clear()
                        values.put(MediaStore.Downloads.IS_PENDING, 0)
                        check(contentResolver.update(uri, values, null, null) == 1)
                    } catch (e: Exception) {
                        contentResolver.delete(uri, null, null)
                        throw e
                    }
                    notifyUser("Đã lưu vào Tải xuống: $fileName")
                } else {
                    val file = File.createTempFile("export-", ".tmp", cacheDir)
                    try {
                        file.writeBytes(bytes)
                    } catch (e: Exception) {
                        file.delete()
                        throw e
                    }
                    runOnUiThread {
                        if (pendingDocument != null || isFinishing || isDestroyed) {
                            file.delete()
                            notifyUser("Vui lòng thử lại sau khi đóng hộp thoại lưu tệp")
                            return@runOnUiThread
                        }
                        pendingDocument = file
                        try {
                            saveFileLauncher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = mimeType
                                putExtra(Intent.EXTRA_TITLE, fileName)
                            })
                        } catch (e: Exception) {
                            pendingDocument = null
                            file.delete()
                            notifyUser("Không thể lưu tệp: ${e.message}")
                        }
                    }
                }
            } catch (e: Exception) {
                notifyUser("Không thể lưu tệp: ${e.message}")
            }
        }

        @JavascriptInterface
        fun googleSignInAvailable(): Boolean =
            resources.getIdentifier("default_web_client_id", "string", packageName) != 0

        @JavascriptInterface
        fun googleSignIn() = runOnUiThread {
            val clientId = resources.getIdentifier("default_web_client_id", "string", packageName)
            if (clientId == 0) return@runOnUiThread loginError("Đơn vị chưa cấu hình đăng nhập Google.")
            val options = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                .requestIdToken(getString(clientId)).requestEmail().build()
            googleSignInLauncher.launch(GoogleSignIn.getClient(this@MainActivity, options).signInIntent)
        }

        @JavascriptInterface
        fun firebaseRememberLoginEnabled(): Boolean =
            getSharedPreferences("login_preferences", Context.MODE_PRIVATE).getBoolean("remember", true)

        @JavascriptInterface
        fun firebaseSetRememberLogin(enabled: Boolean) {
            getSharedPreferences("login_preferences", Context.MODE_PRIVATE).edit().putBoolean("remember", enabled).apply()
        }

        @JavascriptInterface
        fun firebaseCanResume(): Boolean =
            getSharedPreferences("login_preferences", Context.MODE_PRIVATE).getBoolean("remember", false) &&
                auth.currentUser != null

        @JavascriptInterface
        fun firebaseResetPassword(email: String) = runOnUiThread {
            val value = email.trim()
            if (!android.util.Patterns.EMAIL_ADDRESS.matcher(value).matches()) {
                deliverFirebase("onPasswordReset", JSONObject().put("error", "Nhập địa chỉ email hợp lệ."))
                return@runOnUiThread
            }
            auth.setLanguageCode("vi")
            auth.sendPasswordResetEmail(value).withNetworkDeadline().addOnCompleteListener { task ->
                val result = JSONObject()
                val error = task.exception
                if (error != null && (error as? FirebaseAuthException)?.errorCode != "ERROR_USER_NOT_FOUND") {
                    val message = when (error) {
                        is TimeoutException -> "Chưa xác nhận được yêu cầu. Kiểm tra hộp thư hoặc thử lại sau."
                        is FirebaseNetworkException -> "Chưa kết nối được Firebase. Kiểm tra mạng rồi thử lại."
                        is FirebaseTooManyRequestsException -> "Bạn đã gửi nhiều yêu cầu. Vui lòng thử lại sau."
                        else -> "Chưa gửi được liên kết đặt lại mật khẩu. Vui lòng kiểm tra email và thử lại."
                    }
                    result.put("error", message)
                }
                deliverFirebase("onPasswordReset", result)
            }
        }

        @JavascriptInterface
        fun firebaseSignIn(email: String, password: String) = runOnUiThread {
            authenticate(request = { auth.signInWithEmailAndPassword(email, password) }) {
                loadFirebaseProfile()
            }
        }

        @JavascriptInterface
        fun firebaseRegister(email: String, password: String) = runOnUiThread {
            authenticate(registering = true, request = { auth.createUserWithEmailAndPassword(email.trim(), password) }) { result ->
                val uid = result.user?.uid ?: return@authenticate loginError("Vui lòng đăng nhập lại.")
                deliverLogin(JSONObject().put("needsProfile", true).put("uid", uid))
            }
        }

        @JavascriptInterface
        fun firebaseRetryProfile() = runOnUiThread { loadFirebaseProfile() }

        @JavascriptInterface
        fun firebaseListUnits(uid: String) {
            val result = JSONObject().put("uid", uid)
            if (auth.currentUser?.uid != uid) {
                deliverFirebase("onFirebaseUnits", result.put("error", "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."))
                return
            }
            db.collection("registeredUnits").orderBy("name").get(Source.SERVER).withNetworkDeadline()
                .addOnSuccessListener { snapshot ->
                    val units = JSONArray()
                    for (doc in snapshot) {
                        val name = doc.get("name") as? String ?: continue
                        if (name.isNotBlank() && doc.id.matches(Regex("[A-Za-z0-9]{20}")))
                        units.put(JSONObject().put("id", doc.id).put("name", name))
                    }
                    deliverFirebase("onFirebaseUnits", result.put("units", units))
                }
                .addOnFailureListener { error ->
                    deliverFirebase("onFirebaseUnits", result.put("error", firestoreMessage(error, "tải danh sách chi đoàn")))
                }
        }

        @JavascriptInterface
        fun firebaseMemberDirectory(uid: String, unitCode: String, requestId: Int) {
            val result = JSONObject().put("requestId", requestId).put("uid", uid)
            if (auth.currentUser?.uid != uid) {
                deliverFirebase("onMemberDirectory", result.put("error", "Phiên đăng nhập đã thay đổi. Vui lòng đăng nhập lại."))
                return
            }
            db.collection("users").whereEqualTo("unitCode", unitCode).whereEqualTo("role", "doan_vien")
                .get(Source.SERVER).withNetworkDeadline()
                .addOnSuccessListener { snapshot ->
                    if (auth.currentUser?.uid != uid) return@addOnSuccessListener
                    val members = JSONArray()
                    for (doc in snapshot) {
                        members.put(JSONObject().put("phone", (doc.get("phone") as? String).orEmpty())
                            .put("name", (doc.get("displayName") as? String).orEmpty()))
                    }
                    deliverFirebase("onMemberDirectory", result.put("members", members))
                }
                .addOnFailureListener { error ->
                    deliverFirebase("onMemberDirectory", result.put("error", firestoreMessage(error, "đối chiếu đăng ký")))
                }
        }

        @JavascriptInterface
        fun firebaseSaveMemberPhone(uid: String, phone: String, requestId: Int) {
            val result = JSONObject().put("uid", uid).put("requestId", requestId)
            if (auth.currentUser?.uid != uid || !MEMBER_PHONE.matches(phone)) {
                deliverFirebase("onMemberPhoneSaved", result.put("error", "Kiểm tra số điện thoại và tài khoản đang đăng nhập."))
                return
            }
            db.collection("users").document(uid).update("phone", phone).withNetworkDeadline()
                .addOnSuccessListener { deliverFirebase("onMemberPhoneSaved", result.put("phone", phone)) }
                .addOnFailureListener { deliverFirebase("onMemberPhoneSaved", result.put("error", firestoreMessage(it, "lưu số điện thoại"))) }
        }

        @JavascriptInterface
        fun firebaseCompleteProfile(role: String, fullName: String, unitValue: String, phone: String) {
            val user = auth.currentUser ?: return loginError("Vui lòng đăng nhập lại.")
            val name = fullName.trim()
            val value = unitValue.trim()
            if (role !in setOf("bi_thu", "doan_vien") || name.length !in 1..120 ||
                value.length !in 1..120 || (role == "doan_vien" && !value.matches(Regex("[A-Za-z0-9]{20}")))) {
                return loginError("Vui lòng kiểm tra họ tên, vai trò và chi đoàn.")
            }
            if (role == "doan_vien" && !MEMBER_PHONE.matches(phone)) {
                return loginError("Nhập số điện thoại hợp lệ để Bí thư đối chiếu danh sách.")
            }
            val profile = db.collection("users").document(user.uid)
            val directory = db.collection("registeredUnits")
            val unit = if (role == "bi_thu") directory.document() else directory.document(value)
            db.runTransaction { tx ->
                if (!tx.get(profile).exists()) {
                    val unitName = if (role == "bi_thu") {
                        tx.set(unit, mapOf("name" to value))
                        value
                    } else {
                        tx.get(unit).get("name") as? String ?: throw FirebaseFirestoreException(
                            "Chi đoàn không còn trong danh sách.", FirebaseFirestoreException.Code.NOT_FOUND)
                    }
                    val fields = mutableMapOf("displayName" to name, "role" to role,
                        "unitCode" to unit.id, "unitName" to unitName)
                    if (role == "doan_vien") fields["phone"] = phone
                    tx.set(profile, fields)
                }
                true
            }.withNetworkDeadline().addOnSuccessListener {
                if (auth.currentUser?.uid == user.uid) loadFirebaseProfile()
            }.addOnFailureListener { error ->
                if (auth.currentUser?.uid == user.uid) loginError(
                    if ((error as? FirebaseFirestoreException)?.code == FirebaseFirestoreException.Code.NOT_FOUND)
                        "Chi đoàn không còn trong danh sách. Tải lại danh sách và chọn lại."
                    else firestoreMessage(error, "lưu hồ sơ chi đoàn"))
            }
        }

        @JavascriptInterface
        fun firebaseSignOut() = runOnUiThread {
            if (NEWS_ATTACHMENTS_ENABLED) newsAttachments.close()
            unitWork.close()
            auth.signOut()
        }

        @JavascriptInterface
        fun newsAttachmentsEnabled(): Boolean = NEWS_ATTACHMENTS_ENABLED
    }

    private companion object {
        const val NEWS_ATTACHMENTS_ENABLED = false
        val MEMBER_PHONE = Regex("0[0-9]{9,10}")
        const val APP_URL = "https://appassets.androidplatform.net/assets/www/index.html"
    }
}
