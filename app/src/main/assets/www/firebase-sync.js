window.DoanFirebase = {
  loginForm(registering, resetting = false) {
    const bridge = window.AndroidBridge;
    if (!bridge?.firebaseSignIn) return "<p>Mở ứng dụng Android để đăng nhập bằng email.</p>";
    const symbol = id => `<svg class="ui-icon" aria-hidden="true"><use href="icons.svg#${id}"></use></svg>`;
    const submitLabel = resetting ? "GỬI LIÊN KẾT ĐẶT LẠI" : registering ? "TẠO TÀI KHOẢN" : "ĐĂNG NHẬP";
    const remember = bridge.firebaseRememberLoginEnabled?.() !== false;
    return `<form class="auth-form" novalidate onsubmit="event.preventDefault();App.${resetting ? "resetPassword" : "loginWithEmail"}(this)">
      ${resetting ? '<p class="auth-description">Nhập email tài khoản để nhận liên kết đặt lại mật khẩu.</p>' : ""}
      <label class="auth-input-wrap">
        <span class="sr-only">Email</span>${symbol("mail")}
        <input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Email" required>
      </label>
      ${resetting ? "" : `<div class="auth-input-wrap">
        ${symbol("lock")}<label class="sr-only" for="auth-password">Mật khẩu</label>
        <input id="auth-password" name="password" type="password" placeholder="Mật khẩu"
          autocomplete="${registering ? "new-password" : "current-password"}" ${registering ? 'minlength="6"' : ""} required>
        <button type="button" class="auth-eye" aria-label="Hiện mật khẩu" aria-pressed="false"
          onclick="App.togglePassword(this)">${symbol("eye-off")}</button>
      </div>`}
      ${!registering && !resetting ? `<div class="auth-options">
        <label class="auth-remember"><input type="checkbox" name="remember" ${remember ? "checked" : ""}>Ghi nhớ đăng nhập</label>
        <button type="button" class="auth-link" onclick="App.showPasswordReset()">Quên mật khẩu?</button>
      </div>` : ""}
      ${registering ? '<p class="auth-hint">Mật khẩu có ít nhất 6 ký tự.</p>' : ""}
      <button type="submit" class="btn-primary auth-submit" data-auth-submit="${submitLabel}">${submitLabel} ${symbol("arrow-right")}</button>
      ${!registering && !resetting ? '<div class="auth-divider">Bạn chưa có tài khoản?</div>' : ""}
      <button type="button" class="btn-outline auth-register" onclick="App.showRegistration(${!registering && !resetting})">
        ${symbol(registering || resetting ? "back" : "user-plus")}${registering || resetting ? "QUAY LẠI ĐĂNG NHẬP" : "ĐĂNG KÝ TÀI KHOẢN"}
      </button>
      </form>${!registering && !resetting && bridge.googleSignInAvailable?.() ? '<button class="btn-outline auth-google" onclick="App.loginWithGoogle()">Đăng nhập bằng Google</button>' : ""}`;
  },

  profileForm(escapedUid) {
    return `<p>UID đang đăng nhập: <code>${escapedUid}</code></p>
      <button type="button" class="btn-outline" onclick="App.retryFirebaseProfile()">Tải hồ sơ đã được cấp</button>
      <form class="profile-form" id="registration-profile" onsubmit="event.preventDefault();App.completeRegistration(this)">
      <label class="form-label">Họ và tên<input class="form-control" name="fullName" autocomplete="name" maxlength="120" required></label>
      <label class="form-label">Vai trò<select class="form-control" name="role" required onchange="App.changeRegistrationRole(this.form)">
        <option value="">Chọn vai trò</option><option value="doan_vien">Đoàn viên</option><option value="bi_thu">Bí thư</option>
      </select></label>
      <label hidden>Số điện thoại đối chiếu<input class="form-control" name="phone" type="tel" autocomplete="tel" disabled></label>
      <div id="registration-unit"></div>
      <button class="btn-primary">Hoàn tất đăng ký</button>
      <button type="button" class="btn-outline" onclick="App.accountSettings()">Quay lại đăng nhập</button>
    </form>`;
  }
};
