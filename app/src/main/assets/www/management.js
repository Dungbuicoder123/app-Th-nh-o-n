window.DoanManagement = (() => {
  let context;
  let sequence = 0;
  let unitInfo;
  let unitLoad = 0;
  let unitLoading = false;
  let unitError = "";
  const pending = new Map();
  const esc = value => String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  function init(options) { context = options; }
  function request(operation, body = {}, send) {
    const session = context.session();
    if (!session) return Promise.reject(Error("Vui lòng đăng nhập lại."));
    const requestId = ++sequence;
    return new Promise((resolve,reject) => {
      pending.set(requestId,{uid:session.uid,resolve,reject});
      try {
        if (send) send(session,requestId);
        else window.AccountManagement.request(session.uid,requestId,operation,JSON.stringify(body));
      } catch (error) { pending.delete(requestId); reject(error); }
    });
  }
  function complete(result) {
    const task = pending.get(result.requestId);
    if (!task || result.uid !== task.uid || result.uid !== context.session()?.uid) return;
    pending.delete(result.requestId);
    if (result.error) task.reject(Error(result.error));
    else task.resolve(result);
  }
  function reset() {
    pending.forEach(task=>task.reject(Error("Phiên đăng nhập đã thay đổi.")));
    pending.clear();
    unitInfo = null;
    unitLoad++;
    unitLoading = false;
    unitError = "";
  }
  function selectedUnitKey() {
    return "doan_officer_unit/" + context.session()?.uid;
  }
  function scope() {
    if (!context.session()?.officer) return "";
    const active = unitInfo?.units.find(u=>u.id===context.session().unitCode);
    return `<div class="card officer-scope" role="status">
      <strong>${unitLoading ? "Đang tải danh sách chi đoàn…" : "Đang quản lý: " + esc(active?.name || context.unitName())}</strong>
      <p>${unitError ? esc(unitError) : "Cán bộ có quyền quản lý tất cả chi đoàn. Dữ liệu bên dưới thuộc chi đoàn đang chọn."}</p>
      <button class="btn-outline" onclick="DoanManagement.units()">Đổi / quản lý chi đoàn</button>
      ${unitError ? '<button class="btn-outline" onclick="DoanManagement.restoreUnit()">Thử đồng bộ lại</button>' : ""}
    </div>`;
  }
  async function loadUnits() {
    const generation = ++unitLoad;
    const uid = context.session()?.uid;
    unitLoading = true;
    unitError = "";
    context.changed();
    try {
      const result = await request("units");
      if (generation !== unitLoad || uid !== context.session()?.uid) return null;
      result.units.sort((a,b)=>String(a.name).localeCompare(String(b.name),"vi"));
      unitInfo = result;
      return result;
    } catch (e) {
      if (generation !== unitLoad || uid !== context.session()?.uid) return null;
      unitError = e.message;
      throw e;
    } finally {
      if (generation === unitLoad) { unitLoading = false; context.changed(); }
    }
  }
  async function restoreUnit() {
    if (!context.session()?.officer) return;
    try {
      const info = await loadUnits();
      if (!info) return;
      let saved;
      try { saved = localStorage.getItem(selectedUnitKey()); } catch {}
      const target = info.units.find(u=>u.id===saved)
        || info.units.find(u=>u.id!==info.homeUnit) || info.units.find(u=>u.id===info.homeUnit);
      if (target) {
        if (target.id !== context.session()?.unitCode) context.selectUnit(target);
      } else {
        unitError = "Chưa có chi đoàn. Mở Quản lý chi đoàn để thêm thông tin.";
      }
      context.changed();
    } catch (e) { /* scope displays the error with a retry action. */ }
  }
  async function account() {
    context.open('<p role="status">Đang tải thông tin đăng nhập…</p>');
    try {
      const info = await request("account");
      context.open(`<h3>Thông tin đăng nhập</h3><p>Email hiện tại <strong>${esc(info.email)}</strong></p>
        ${info.passwordProvider ? `<form onsubmit="event.preventDefault();DoanManagement.changeAccount(this)">
          <label class="form-label">Thao tác<select class="form-control" name="operation" onchange="DoanManagement.accountFields(this.form)">
            <option value="email">Đổi email</option><option value="password">Đổi mật khẩu</option></select></label>
          <label class="form-label">Mật khẩu hiện tại<input class="form-control" type="password" name="currentPassword" autocomplete="current-password" required></label>
          <div id="account-new-value"></div><p id="account-result" role="status"></p>
          <button class="btn-primary">Cập nhật</button></form>` : '<p>Tài khoản đang dùng Google. Bạn có thể đặt mật khẩu bằng email để đăng nhập bằng email và mật khẩu.</p>'}
        <button class="btn-outline" onclick="DoanManagement.resetPassword(this)">Gửi email đặt lại mật khẩu</button>
        <button class="btn-outline" onclick="App.closeModal()">Đóng</button>`);
      const form = document.getElementById("account-new-value")?.closest("form");
      if (form) accountFields(form);
    } catch (e) { context.toast("Chưa tải được tài khoản",e.message); }
  }
  function accountFields(form) {
    document.getElementById("account-new-value").innerHTML = form.elements.operation.value === "email"
      ? '<label class="form-label">Email mới<input class="form-control" type="email" name="value" autocomplete="email" required></label><p>Mở thư gửi tới email mới để xác minh thay đổi.</p>'
      : '<label class="form-label">Mật khẩu mới<input class="form-control" type="password" name="value" autocomplete="new-password" minlength="6" required></label><label class="form-label">Nhập lại mật khẩu mới<input class="form-control" type="password" name="confirmation" autocomplete="new-password" minlength="6" required></label>';
  }
  async function changeAccount(form) {
    if (!form.reportValidity()) return;
    const operation = form.elements.operation.value;
    const value = operation === "email" ? form.elements.value.value.trim() : form.elements.value.value;
    if (operation === "password" && value !== form.elements.confirmation.value)
      return context.toast("Kiểm tra mật khẩu","Hai mật khẩu mới chưa khớp.");
    const fields = [...form.elements];
    const currentPassword = form.elements.currentPassword.value;
    fields.forEach(field=>field.disabled=true);
    try {
      await request(operation,{currentPassword,value});
      form.reset();
      accountFields(form);
      document.getElementById("account-result").textContent = operation === "email"
        ? "Đã gửi thư xác minh. Sau khi xác minh, hãy đăng nhập bằng email mới."
        : "Đã đổi mật khẩu thành công.";
    } catch (e) { context.toast("Chưa cập nhật được",e.message); }
    finally { fields.forEach(field=>field.disabled=false); }
  }
  async function resetPassword(button) {
    button.disabled = true;
    try { await request("resetPassword"); context.toast("Đã gửi yêu cầu","Kiểm tra hộp thư của email đăng nhập để đặt lại mật khẩu."); }
    catch (e) { context.toast("Chưa gửi được email",e.message); }
    finally { button.disabled=false; }
  }
  async function units() {
    if (!context.manager()) return;
    context.open('<p role="status">Đang tải chi đoàn…</p>');
    try {
      const info = await loadUnits();
      if (!info) return;
      const own = unitInfo.units.find(u=>u.id===unitInfo.homeUnit);
      context.open(`<h3>Quản lý chi đoàn</h3><p>Chi đoàn đã lưu sẽ xuất hiện khi Đoàn viên đăng ký tài khoản.</p>
        ${!own && /^[A-Za-z0-9]{20}$/.test(unitInfo.homeUnit) ? '<button class="btn-primary" onclick="DoanManagement.editUnit(\'home\')">Thêm thông tin đơn vị của tôi</button>' : ""}
        ${unitInfo.units.map((u,index)=>`<div class="card"><strong>${esc(u.name)}</strong><p>${esc(u.address)} · ${esc(u.contactPhone || "Chưa có SĐT")}</p>
          <small>Mã chi đoàn ${esc(u.id)}</small>
          <button class="btn-outline" onclick="DoanManagement.editUnit('${index}')">Chỉnh sửa</button>
          ${unitInfo.officer ? `<button class="btn-primary" onclick="DoanManagement.selectUnit(${index})">${context.session().unitCode===u.id ? "Đang quản lý" : "Quản lý chi đoàn này"}</button>` : ""}</div>`).join("")}
        ${unitInfo.officer ? '<button class="btn-primary" onclick="DoanManagement.editUnit(\'new\')">+ Thêm chi đoàn trực thuộc</button>' : ""}
        <button class="btn-outline" onclick="App.closeModal()">Đóng</button>`);
    } catch (e) {
      context.open(`<p role="alert">${esc(e.message)}</p><button class="btn-outline" onclick="DoanManagement.units()">Thử lại</button><button class="btn-outline" onclick="App.closeModal()">Đóng</button>`);
    }
  }
  function editUnit(index) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const id = Array.from(crypto.getRandomValues(new Uint8Array(20)), n=>alphabet[n % alphabet.length]).join("");
    const unit = index === "home" ? {id:unitInfo.homeUnit,name:unitInfo.homeName} :
      index === "new" ? {id,name:""} : unitInfo.units[Number(index)];
    if (!unit) return;
    context.open(`<h3>${index==="new" ? "Thêm chi đoàn trực thuộc" : "Thông tin chi đoàn"}</h3>
      <form data-id="${esc(unit.id)}" onsubmit="event.preventDefault();DoanManagement.saveUnit(this)">
      <label class="form-label">Tên chi đoàn<input class="form-control" name="name" value="${esc(unit.name)}" maxlength="120" required></label>
      <label class="form-label">Địa chỉ<input class="form-control" name="address" value="${esc(unit.address)}" maxlength="250"></label>
      <label class="form-label">Số điện thoại liên hệ<input class="form-control" name="contactPhone" value="${esc(unit.contactPhone)}" type="tel"></label>
      <button class="btn-primary">Lưu chi đoàn</button><button type="button" class="btn-outline" onclick="DoanManagement.units()">Quay lại</button></form>`);
  }
  async function saveUnit(form) {
    if (!form.reportValidity()) return;
    const body = {id:form.dataset.id,name:form.elements.name.value.trim(),address:form.elements.address.value.trim(),
      contactPhone:DoanFeatures.phoneKey(form.elements.contactPhone.value)};
    if (body.contactPhone && !/^0\d{9,10}$/.test(body.contactPhone)) return context.toast("Kiểm tra SĐT","Nhập số bắt đầu bằng 0 hoặc +84.");
    const button = form.querySelector('button');
    if (button.disabled) return;
    button.disabled = true;
    try {
      await request("saveUnit",body);
      if (context.session()?.unitCode === body.id) context.renameUnit(body.name);
      await units();
      context.toast("Đã lưu chi đoàn","Đoàn viên có thể tải lại danh sách khi đăng ký.");
    } catch (e) { context.toast("Chưa lưu được chi đoàn",e.message); }
    finally { button.disabled=false; }
  }
  function selectUnit(index) {
    const unit = unitInfo?.units[index];
    if (unit && unitInfo.officer) {
      if (context.selectUnit(unit) !== false) {
        try { localStorage.setItem(selectedUnitKey(),unit.id); } catch {}
      }
    }
  }
  return {init,request,complete,reset,scope,restoreUnit,account,accountFields,changeAccount,resetPassword,units,editUnit,saveUnit,selectUnit};
})();
