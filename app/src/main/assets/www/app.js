(function () {

  let storageKey = null;
  let firebaseLoginPending = false;
  let registrationPage = "login";
  let registrationUid = "";
  let profileError = "";

  let firebaseSession = null;
  let directoryRequest = 0;
  let directoryByPhone = null;
  let directoryMessage = "";
  let phoneRequest = 0;
  let savingPhone = false;

  let inputRevision = 0;
  const newsAttachmentsEnabled = window.AndroidBridge?.newsAttachmentsEnabled?.() === true;
  let newsDraft = "";
  let newsFiles = [];
  let newsPicking = false;
  let entryBusy = false;

  const roleLabels = { secretary: "Bí thư chi đoàn", member: "Đoàn viên", ward_officer: "Cán bộ Đoàn xã, phường" };
  function localDate(date = new Date()) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function cloneInitialData() {
    return JSON.parse(JSON.stringify(window.DOAN_DATA));
  }

  function loadState() {
    const defaults = {
      currentRoleId: "member",
      currentScreen: "login",
      meetingTab: "Tất cả",
      meetingSearch: "",
      memberFilter: "all",
      memberSearch: "",
      wardMonth: localDate().slice(0, 7),
      workerShift: "Ca chiều (14h-22h)",
      newsCategory: "Trang chủ",
      newsSearchOpen: false,
      newsSearch: "",
      quickReportTab: "create", // 'create' | 'list'
      registerTab: "open",
      registerCatFilter: "all",
      lookupCode: "",
      profileRequests: {},
      approvalFilter: "all",
      evidenceFilter: "all",
      calYear: new Date().getFullYear(),
      calMonth: new Date().getMonth(),
      calSelectedDate: localDate(),
      achievementTab: "personal",
      auditFilter: "all",
      auditSearch: "",
      reminderSettings: {
        before24h: true,
        before2h: true,
        zaloOA: true,
        autoSuggestMakeup: true
      },
      ...cloneInitialData()
    };
    try {
      const saved = storageKey && JSON.parse(localStorage.getItem(storageKey) || "null");
      if (!saved || !Array.isArray(saved.members) || !Array.isArray(saved.meetings)) return defaults;
      // Older installations may not have fields added after their last save.
      return { ...defaults, ...saved, reminderSettings: { ...defaults.reminderSettings, ...saved.reminderSettings } };
    } catch {
      return defaults;
    }
  }

  const work = window.DoanUnitWork;
  const routes = [];
  let selectedTab = "home";
  let displayedQr = "";
  let pendingQr = "";
  let state = loadState();

  function attendanceText(meeting) {
    if (meeting.cloud && !canManage()) {
      return meeting.attendedMemberIds.includes(firebaseSession.uid) ? "Bạn đã điểm danh" : "Bạn chưa điểm danh";
    }
    return meeting.attendees + "/" + meeting.totalTarget + " đoàn viên";
  }

  function totalPoints(member, uid) {
    return (Number(member?.points) || 0) + work.points(uid) +
      (uid === firebaseSession?.uid ? (state.personalCredit || 0) + 15 * state.evidences.filter(e =>
        !e.cloud && !e.memberId && e.status === "verified" && e.submitterName === getCurrentRole()?.userName).length : 0);
  }

  function conflictsWithShift(time, shift, endTime) {
    const clock = /(?:^|\s)([01]\d|2[0-3]):([0-5]\d)(?:$|\s)/;
    const minutes = match => Number(match[1]) * 60 + Number(match[2]);
    const start = clock.exec(time || "");
    if (!start) return true;
    const from = minutes(start);
    const end = clock.exec(endTime || "");
    let until = end ? minutes(end) : from + 1;
    if (until <= from) until += 1440;
    const workStart = shift.startsWith("Ca sáng") ? 360 : shift.startsWith("Ca chiều") ? 840 : 1320;
    return [-1440, 0, 1440].some(offset =>
      from < workStart + offset + 480 && until > workStart + offset);
  }

  async function sendWork(operation, body) {
    try { await work.write(operation, body); return true; }
    catch (error) { showToast("Chưa xác nhận ghi dữ liệu", error.message); return false; }
  }

  function refreshUnitWork() {
    if (!firebaseSession) return;
    work.project(state, canManage());
    if (canManage()) {
      work.syncLegacyFeed(state);
      work.migrateRoster(state.members);
      work.syncCounts(getMemberCounts());
    }
    if (work.unitName) {
      const role = getCurrentRole();
      role.unit = work.unitName;
      role.subtitle = roleLabels[role.id] + " · " + work.unitName;
    }
    if (work.own) {
      const role = getCurrentRole();
      role.userName = work.own.name;
      role.avatarText = role.userName.trim().split(/\s+/).slice(-2).map(w=>w[0]).join("");
      role.phone = work.own.phone;
    }
    if (pendingQr && state.meetings.some(m => m.id === pendingQr && m.qrCode)) {
      const id = pendingQr;
      pendingQr = "";
      App.openQRModal(id);
    }
    if (displayedQr) {
      const meeting = state.meetings.find(m => m.id === displayedQr);
      if (!meeting || meeting.status !== "Đang điểm danh") closeModal();
      else {
        const count = document.getElementById("qr-live-count");
        if (count) count.textContent = meeting.attendees + "/" + meeting.totalTarget;
      }
    }
    const screen = document.getElementById("app-screen");
    if (!screen.contains(document.activeElement) || !document.activeElement.matches("input,textarea,select")) {
      const scroll = screen.scrollTop;
      render();
      screen.scrollTop = scroll;
    }
    openPendingArticle();
  }
  function openPendingArticle() {
    const raw = sessionStorage.getItem("pendingArticle");
    if (!raw || !firebaseSession || !work.eventsReady) return;
    const link = JSON.parse(raw);
    sessionStorage.removeItem("pendingArticle");
    if (link.unit !== firebaseSession.unitCode) return showToast("Bài viết thuộc đơn vị khác","Hãy mở liên kết bằng tài khoản của đơn vị đăng bài.");
    if (!state.news.some(n => n.cloud && n.id === link.id)) return showToast("Không tìm thấy bài viết","Bài viết có thể đã được gỡ.");
    App.openTab("news");
    App.openNewsDetailModal(link.id);
  }
  let toastTimer = null;
  let pendingEvidenceImage = "";
  let pendingMeetingDocs = [];

  async function withAttachments(mode, operation) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("doan_vien_so_attachments", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("files", mode);
        const request = operation(tx.objectStore("files"));
        tx.oncomplete = () => resolve(request?.result);
        tx.onabort = () => reject(tx.error || new Error("Ghi tệp thất bại"));
      });
    } finally {
      db.close();
    }
  }
  let csvPreviewRows = [];
  let csvPreviewError = "";

  function saveState() {
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(work.localOnly(state)));
    } catch (error) {
      state = loadState();
      render();
      showToast("Chưa lưu được thay đổi", "Bộ nhớ thiết bị không khả dụng hoặc đã đầy. Hãy thử lại với tệp nhỏ hơn.");
      throw error;
    }
  }

  function escHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function getCurrentRole() {
    return state.roles.find((r) => r.id === state.currentRoleId) || state.roles[0];
  }

  function getMemberCounts(members = work.scanRoster(state.members)) {
    const local = members.filter((m) => m.status === "local").length;
    const far = members.filter((m) => m.status === "far").length;
    const transfer = members.filter((m) => m.status === "transfer").length;
    return { total: members.length, local, far, transfer };
  }

  function getCategoryMeta(catName) {
    return (
      state.activityCategories.find((c) => c.name === catName) || {
        name: catName,
        color: "#005BAC",
        bg: "#EFF6FF"
      }
    );
  }

  function logAudit(action, target, details) {
    const role = getCurrentRole();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const timeStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    state.auditLogs.unshift({
      id: "LOG-" + Date.now(),
      time: timeStr,
      actor: role.userName,
      role: role.roleName,
      action,
      target,
      details
    });
    if (state.auditLogs.length > 60) state.auditLogs.pop();
  }

  function showToast(title, body) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    container.innerHTML = `
      <div class="toast-banner">
        <div style="font-size:18px;line-height:1;">${icon("bell")}</div>
        <div style="flex:1">
          <div style="font-weight:700;margin-bottom:2px;">${escHtml(title)}</div>
          <div style="opacity:0.9;font-size:12px;line-height:1.35;">${escHtml(body)}</div>
        </div>
      </div>
    `;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      container.innerHTML = "";
    }, 3800);
  }

  function closeModal(published = false) {
    if (entryBusy) return showToast("Đang lưu bài viết", "Vui lòng chờ hoàn tất tải tệp và lưu bài.");
    if (newsDraft && firebaseSession) window.NewsAttachments?.discard(firebaseSession.uid, newsDraft, published);
    newsDraft = "";
    newsFiles = [];
    newsPicking = false;
    pendingQr = "";
    displayedQr = "";
    document.getElementById("modal-root").innerHTML = "";
  }

  function openModal(html) {
    const root = document.getElementById("modal-root");
    root.innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
        <div class="modal-sheet">${html}</div>
      </div>
    `;
  }

  function icon(name) {
    return `<svg class="ui-icon" aria-hidden="true"><use href="icons.svg#${name}"></use></svg>`;
  }



  function renderBottomNav() {
    const nav = document.getElementById("bottom-nav");
    if (state.currentScreen === "login") {
      nav.style.display = "none";
      return;
    }
    nav.style.display = "flex";
    const tabs =
      state.currentRoleId === "ward_officer"
        ? [
            { id: "news", label: "Bảng tin", icon: icon("news") },
            { id: "home", label: "Công tác", icon: icon("home") },
            { id: "ward", label: "Tổng hợp", icon: icon("chart") },
            { id: "approvals", label: "Duyệt ĐK", icon: icon("calendar") },
            { id: "account", label: "Cá nhân", icon: icon("user") }
          ]
        : state.currentRoleId === "member"
        ? [
            { id: "news", label: "Bảng tin", icon: icon("news") },
            { id: "home", label: "Công tác", icon: icon("home") },
            { id: "scan", label: "Điểm danh", icon: icon("qr") },
            { id: "register", label: "Đăng ký", icon: icon("calendar") },
            { id: "account", label: "Cá nhân", icon: icon("user") }
          ]
        : [
            { id: "news", label: "Bảng tin", icon: icon("news") },
            { id: "home", label: "Công tác", icon: icon("home") },
            { id: "meetings", label: "Sinh hoạt", icon: icon("calendar") },
            { id: "members", label: "Đoàn viên", icon: icon("users") },
            { id: "account", label: "Cá nhân", icon: icon("user") }
          ];

    nav.innerHTML = tabs
      .map(
        (t) => `
      <button class="nav-tab ${selectedTab === t.id ? "active" : ""}" onclick="App.openTab('${t.id}')">
        ${t.icon}
        <span>${t.label}</span>
      </button>
    `
      )
      .join("");
  }

  function renderLogin() {
    const title = registrationPage === "profile" ? "Hoàn tất hồ sơ" : registrationPage === "retry" ? "Kết nối tài khoản"
      : registrationPage === "register" ? "Tạo tài khoản" : registrationPage === "reset" ? "Quên mật khẩu?" : "Chào mừng bạn!";
    return `<div class="auth-page">
      <header class="auth-brand">
        <img class="auth-emblem" src="union-badge.svg" alt="Huy hiệu Đoàn TNCS Hồ Chí Minh" width="86" height="98">
        <h1 class="auth-wordmark">ĐOÀN VIÊN <span>SỐ</span></h1>
        <p class="auth-tagline">Nền tảng số hỗ trợ quản lý, kết nối<br>và nâng cao hiệu quả hoạt động Đoàn</p>
      </header>
      <section class="auth-card" aria-labelledby="auth-heading">
        <h2 class="auth-heading" id="auth-heading">${title}</h2>
        <p id="auth-status" role="status" aria-live="polite" hidden></p>
        ${registrationPage === "profile" ? window.DoanFirebase.profileForm(escHtml(registrationUid))
          : registrationPage === "retry" ? '<p class="auth-description">' + escHtml(profileError) + '</p><button class="btn-primary" onclick="App.retryFirebaseProfile()">Thử tải lại hồ sơ</button><button class="btn-outline auth-google" onclick="App.accountSettings()">Quay lại đăng nhập</button>'
          : window.DoanFirebase.loginForm(registrationPage === "register", registrationPage === "reset")}
      </section>
      <footer class="auth-footer">
        <div class="auth-team">TEAM 34 – ĐOÀN VIÊN SỐ</div>
        <p>Sản phẩm tham dự Cuộc thi lập trình<br>Hackathon thành phố Đồng Nai năm 2026.</p>
      </footer>
    </div>`;
  }

  // 2. MÀN HÌNH TRANG CHỦ CÔNG TÁC ĐOÀN (Đã tách riêng Tin tức sự kiện sang tab Bảng tin)
  function renderHome() {
    const role = getCurrentRole();
    const counts = canManage() ? getMemberCounts() : work.counts || {total:"…",local:"…",far:"…",transfer:"…"};
    const unreadNotifs = state.notifications.filter((n) => n.unread).length;
    const liveMeeting = state.meetings.find(m => m.status === "Đang điểm danh");
    const pendingRegs = state.registrations.filter((r) => r.status === "pending").length;
    const pendingEvs = state.evidences.filter((e) => e.status === "pending").length;

    return `
      <div class="hero-header">
        <div class="hero-top">
          <div class="user-pill">
            <div class="avatar-circle">${escHtml(role.avatarText)}</div>
            <div class="user-meta">
              <h2>${escHtml(role.userName)}</h2>
              <p>${escHtml(role.subtitle)}</p>
            </div>
          </div>
          <button class="notif-btn" onclick="App.go('reminders')" title="Thông báo">
            ${icon("bell")}
            ${unreadNotifs > 0 ? `<span class="notif-badge">${unreadNotifs}</span>` : ""}
          </button>
        </div>
      </div>

      <!-- Lưới 8 tính năng pastel cốt lõi -->
      <div class="feature-grid-card">
        <div class="feature-grid">
          <button class="feature-item" onclick="App.go('meetings')">
            <div class="feature-icon-box bg-pastel-orange">${icon("calendar")}</div>
            <span class="feature-label">Sinh hoạt chi đoàn</span>
          </button>
          <button class="feature-item" onclick="App.go('scan')">
            <div class="feature-icon-box bg-pastel-purple">${icon("qr")}</div>
            <span class="feature-label">Quét QR điểm danh</span>
          </button>
          <button class="feature-item" onclick="App.go('members')">
            <div class="feature-icon-box bg-pastel-blue">${icon("users")}</div>
            <span class="feature-label">Danh sách ĐV (${counts.total})</span>
          </button>
          <button class="feature-item" onclick="App.go('quick_report')">
            <div class="feature-icon-box bg-pastel-teal">${icon("news")}</div>
            <span class="feature-label">Báo cáo nhanh</span>
          </button>
          <button class="feature-item" onclick="App.go('makeup')">
            <div class="feature-icon-box bg-pastel-pink">${icon("clock")}</div>
            <span class="feature-label">Sinh hoạt bù</span>
          </button>
          <button class="feature-item" onclick="App.go('points')">
            <div class="feature-icon-box bg-pastel-yellow">${icon("star")}</div>
            <span class="feature-label">Chấm công tình nguyện</span>
          </button>
          <button class="feature-item" onclick="App.go('ward')">
            <div class="feature-icon-box bg-pastel-green">${icon("chart")}</div>
            <span class="feature-label">Tổng hợp sinh hoạt</span>
          </button>
          <button class="feature-item" onclick="App.go('reminders')">
            <div class="feature-icon-box bg-pastel-indigo">${icon("bell")}</div>
            <span class="feature-label">Thông báo</span>
          </button>
        </div>
      </div>


      <div class="section-wrap">
        <div class="card" style="padding:14px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
            <strong style="font-size:14.5px;">${escHtml(role.unit)} · ${counts.total} đoàn viên</strong>
            <button class="section-link" onclick="App.go('members')">Chi tiết ></button>
          </div>
          <div class="stats-row">
            <div class="stat-box" onclick="App.goMembersFilter('local')" style="cursor:pointer;">
              <strong style="color:#059669;">${counts.local}</strong>
              <span>Ở địa phương</span>
            </div>
            <div class="stat-box" onclick="App.goMembersFilter('far')" style="cursor:pointer;">
              <strong style="color:#D97706;">${counts.far}</strong>
              <span>Đi làm xa</span>
            </div>
            <div class="stat-box" onclick="App.goMembersFilter('transfer')" style="cursor:pointer;">
              <strong style="color:#4B5563;">${counts.transfer}</strong>
              <span>Chuyển SH</span>
            </div>
          </div>
        </div>

        <!-- Hoạt động đang diễn ra -->
        <div class="section-header">
          <h3>Sinh hoạt đang mở điểm danh</h3>
          <button class="section-link" onclick="App.go('meetings')">Xem tất cả ></button>
        </div>
        ${liveMeeting ? `<div class="card" style="border-left:4px solid var(--primary);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <span class="status-chip live">● ${liveMeeting.status}</span>
            <span style="font-size:12px;font-weight:700;color:var(--primary);">${attendanceText(liveMeeting)}</span>
          </div>
          <div style="font-size:14.5px;font-weight:700;margin:8px 0 4px;">${escHtml(liveMeeting.title)}</div>
          <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:8px;">
            ${icon("pin")} ${escHtml(liveMeeting.location)} · ${icon("clock")} ${escHtml(liveMeeting.time)}
          </div>
          ${
            liveMeeting.documents && liveMeeting.documents.length
              ? `<div style="margin-bottom:10px;">
                  <button class="doc-chip" onclick="App.openMeetingDocsModal('${liveMeeting.id}')">
                    ${icon("file")} ${liveMeeting.documents.length} tài liệu sinh hoạt đính kèm ›
                  </button>
                </div>`
              : ""
          }
          <div style="display:flex;gap:8px;">
            ${
              canManage()
                ? `<button class="btn-primary" style="padding:10px;font-size:13px;" onclick="App.openQRModal('${liveMeeting.id}')">Mở mã QR điểm danh</button>`
                : `<button class="btn-primary" style="padding:10px;font-size:13px;" onclick="App.go('scan')">Quét QR điểm danh ngay</button>`
            }
            <button class="btn-outline" style="white-space:nowrap;" onclick="App.go('quick_report')">Lập báo cáo</button>
          </div>
        </div>` : '<div class="card">Chưa có buổi sinh hoạt đang mở.</div>'}

        ${state.currentRoleId === "secretary" && Object.keys(state.profileRequests).length ? '<button class="btn-outline" onclick="App.go(\'reminders\')">Có yêu cầu cập nhật hồ sơ chờ duyệt</button>' : ""}
        <!-- Nghiệp vụ Đoàn nâng cao -->
        <div class="section-header">
          <h3>Nghiệp vụ Đoàn nâng cao</h3>
          <button class="section-link" onclick="App.go('news')">Bảng tin ›</button>
        </div>
        <div class="ext-chip-grid" style="margin-bottom:12px;">
          <button class="ext-chip-btn" onclick="App.go('register')">
            <span class="ext-chip-icon bg-pastel-blue">${icon("edit")}</span>
            <div>
              <strong>Đăng ký & Mã HS</strong>
              <span>6 nhóm · Phiếu PNG</span>
            </div>
          </button>
          <button class="ext-chip-btn" onclick="App.go('approvals')">
            <span class="ext-chip-icon bg-pastel-green">${icon("check")}</span>
            <div>
              <strong>Duyệt đăng ký</strong>
              <span>${pendingRegs > 0 ? pendingRegs + " hồ sơ chờ duyệt" : "Đã xử lý hết"}</span>
            </div>
          </button>
          <button class="ext-chip-btn" onclick="App.go('evidence')">
            <span class="ext-chip-icon bg-pastel-purple">${icon("camera")}</span>
            <div>
              <strong>Minh chứng HĐ</strong>
              <span>${pendingEvs} chờ xác nhận</span>
            </div>
          </button>
          <button class="ext-chip-btn" onclick="App.go('calendar')">
            <span class="ext-chip-icon bg-pastel-orange">${icon("calendar")}</span>
            <div>
              <strong>Lịch hoạt động</strong>
              <span>Xem theo tháng</span>
            </div>
          </button>
          <button class="ext-chip-btn" onclick="App.go('achievements')">
            <span class="ext-chip-icon bg-pastel-yellow">${icon("award")}</span>
            <div>
              <strong>Thành tích Đoàn</strong>
              <span>Cá nhân & Tập thể</span>
            </div>
          </button>
          <button class="ext-chip-btn" onclick="App.go('import_csv')">
            <span class="ext-chip-icon bg-pastel-indigo">${icon("download")}</span>
            <div>
              <strong>Nhập CSV ĐV</strong>
              <span>Đối chiếu tự động</span>
            </div>
          </button>
        </div>
      </div>
    `;
  }

  // 2B. MÀN HÌNH BẢNG TIN RIÊNG BIỆT (THEO MẪU ẢNH/VIDEO THAM KHẢO, KHÔNG QUỐC KỲ/LOGO)
  function renderNewsAttachments(attachments) {
    return (Array.isArray(attachments) ? attachments : []).filter(file=>{
      try { const url = new URL(file.url); return url.protocol === "https:" && url.hostname === "firebasestorage.googleapis.com"; }
      catch { return false; }
    }).map(file=>{
      const url = escHtml(file.url), name = escHtml(file.name);
      const media = ["image/jpeg","image/png","image/webp"].includes(file.type)
        ? `<img src="${url}" alt="${name}" loading="lazy" style="width:100%;border-radius:12px">`
        : ["video/mp4","video/webm"].includes(file.type)
          ? `<video src="${url}" controls preload="metadata" style="width:100%;border-radius:12px"></video>` : "";
      return `<div class="card">${media}<p><a href="${url}" rel="noopener noreferrer">${icon("file")} ${name}</a></p></div>`;
    }).join("");
  }

  function renderNews() {
    const q = state.newsSearch.trim().toLowerCase();
    const filtered = state.news.filter((n) => {
      const matchCat = state.newsCategory === "Trang chủ" || n.category === state.newsCategory;
      const matchQ =
        !q || n.title.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q);
      return matchCat && matchQ;
    });

    return `
      <div class="news-header">
        <div class="news-header-top">
          <button class="news-icon-btn" onclick="App.toggleNewsSearch()" title="Tìm kiếm tin tức">
            ${icon("search")}
          </button>
          <span class="news-header-title">Bảng tin</span>
          ${state.currentRoleId === "member" ? "" : '<button class="btn-sm" onclick="App.openEntryForm(\'news\')">+ Viết tin</button>'}
          <button class="news-icon-btn" onclick="App.go('reminders')" title="Thông báo">
            ${icon("bell")}
          </button>
        </div>
        ${
          state.newsSearchOpen
            ? `<div style="margin-bottom:10px;">
                <input class="form-control" style="padding:8px 12px;font-size:13px;" placeholder="Tìm kiếm bài viết, sự kiện..." value="${escHtml(state.newsSearch)}" data-search="News" oninput="if (!event.isComposing) App.setNewsSearch(this.value)" oncompositionend="App.setNewsSearch(this.value)" />
              </div>`
            : ""
        }
        <div class="news-cat-tabs">
          ${state.newsCategories
            .map(
              (cat) => `
            <button class="news-cat-tab ${state.newsCategory === cat ? "active" : ""}" onclick="App.setNewsCategory('${cat}')">${cat}</button>
          `
            )
            .join("")}
        </div>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        ${
          filtered.length === 0
            ? `<div class="card" style="text-align:center;color:var(--text-muted);font-size:13px;">Chưa có bài viết nào trong chuyên mục "${escHtml(state.newsCategory)}".</div>`
            : filtered
                .map(
                  (n) => `
              <article class="news-feed-card" onclick="App.openNewsDetailModal('${n.id}')">
                <div class="news-cover" style="background:${n.bannerGradient};">
                  <span class="news-cover-tag">${escHtml(n.bannerLabel || n.tag)}</span>
                  <div class="news-cover-headline">${escHtml(n.title)}</div>
                </div>
                <div class="news-body">
                  <div class="news-title">${escHtml(n.title)}</div>
                  <div class="news-summary">${escHtml(n.summary)}</div>
                  <div class="news-footer" onclick="event.stopPropagation()">
                    <div style="display:flex;align-items:center;gap:14px;">
                      <button class="news-action-btn ${n.liked ? "liked" : ""}" onclick="App.toggleNewsLike('${n.id}')">
                        <span>${icon("heart")}</span>
                        <span>${n.likes}</span>
                      </button>
                      <span>${icon("clock")} ${escHtml(n.date)}</span>
                    </div>
                    <button class="news-action-btn article-chat-btn" onclick="App.openArticleChat('${n.id}')">${icon("msg")} Hỏi AI</button>
                    <button class="news-action-btn" onclick="App.shareNews('${n.id}')">${icon("share")} Sao chép liên kết</button>
                  </div>
                </div>
              </article>
            `
                )
                .join("")
        }
      </div>
    `;
  }

  // 3. MÀN HÌNH TẠO BUỔI SINH HOẠT & MÃ QR ĐIỂM DANH (CÓ TÀI LIỆU ĐÍNH KÈM + LẬP BÁO CÁO NHANH)
  function renderMeetings() {
    const tabs = [
      { key: "Tất cả", count: state.meetings.length },
      { key: "Thường kỳ", count: state.meetings.filter((m) => m.type === "Thường kỳ").length },
      { key: "Chuyên đề", count: state.meetings.filter((m) => m.type === "Chuyên đề").length }
    ];

    const filtered = state.meetings.filter((m) => {
      const matchTab = state.meetingTab === "Tất cả" || m.type === state.meetingTab;
      const matchSearch =
        !state.meetingSearch ||
        m.title.toLowerCase().includes(state.meetingSearch.toLowerCase());
      return matchTab && matchSearch;
    });

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Sinh hoạt chi đoàn</span>
        </div>
        <button data-manager class="btn-sm" style="background:var(--primary);color:#fff;display:flex;align-items:center;gap:4px;" onclick="App.openCreateMeetingModal()">
          ${icon("plus")} Tạo buổi SH
        </button>
      </div>

      <div class="underline-tabs">
        ${tabs
          .map(
            (t) => `
          <button class="u-tab ${state.meetingTab === t.key ? "active" : ""}" onclick="App.setMeetingTab('${t.key}')">
            <span>${t.key}</span>
            <span class="tab-count">${t.count}</span>
          </button>
        `
          )
          .join("")}
      </div>

      <div class="search-bar">
        <div class="search-input-wrap">
          ${icon("search")}
          <input type="text" placeholder="Tìm kiếm theo tiêu đề..." value="${escHtml(state.meetingSearch)}" data-search="Meeting" oninput="if (!event.isComposing) App.setMeetingSearch(this.value)" oncompositionend="App.setMeetingSearch(this.value)" />
        </div>
      </div>

      <div class="section-wrap">
        ${filtered
          .map((m) => {
            const docs = m.documents || [];
            return `
          <div class="meeting-card">
            <div class="meeting-title">${escHtml(m.title)}</div>
            <div class="meeting-meta-row">
              <span class="meeting-meta-label">Trạng thái:</span>
              <span class="status-chip ${m.status === "Đang điểm danh" ? "live" : ""}">${m.status}</span>
            </div>
            <div class="meeting-meta-row">
              <span class="meeting-meta-label">Đơn vị:</span>
              <strong>${escHtml(m.unit)}</strong>
            </div>
            <div class="meeting-meta-row">
              <span class="meeting-meta-label">Địa điểm:</span>
              <span>${escHtml(m.location)}</span>
            </div>
            <div class="meeting-meta-row">
              <span class="meeting-meta-label">Thời gian:</span>
              <span>${escHtml(m.time)}</span>
            </div>
            <div class="meeting-meta-row">
              <span class="meeting-meta-label">Tham dự:</span>
              <strong style="color:var(--primary);">${attendanceText(m)}</strong>
            </div>
            ${
              docs.length > 0
                ? `<div class="doc-chip-list">
                    ${docs
                      .map(
                        (d) => `<button class="doc-chip" onclick="App.openMeetingDocsModal('${m.id}')">${icon("file")} ${escHtml(d.name)}</button>`
                      )
                      .join("")}
                  </div>`
                : `<div style="font-size:11.5px;color:var(--text-muted);margin-top:4px;">Chưa đính kèm tài liệu sinh hoạt</div>`
            }
            <div style="display:flex;gap:7px;margin-top:12px;">
              ${canManage() && m.status === "Đang điểm danh" ? `<button class="btn-outline" onclick="App.openQRModal('${m.id}')">${icon("qr")} Mã QR</button>` : ""}
              ${!canManage() && m.status === "Đang điểm danh" ? `<button class="btn-primary" onclick="App.go('scan')">${icon("qr")} Điểm danh sinh hoạt</button>` : ""}
              ${m.deadline ? `<span>Hạn: ${escHtml(new Date(m.deadline).toLocaleString("vi-VN"))}</span>` : ""}
              <button data-manager class="btn-sm" style="background:#EFF6FF;color:var(--primary);" onclick="App.startQuickReportFromMeeting('${m.id}')">
                ${icon("file")} Báo cáo nhanh
              </button>
            </div>
          </div>
        `;
          })
          .join("")}
      </div>
    `;
  }

  // 3B. TẠO BÁO CÁO NHANH CHO BÍ THƯ (THEO MẪU 6 MỤC: THỜI GIAN, ĐỊA ĐIỂM, THÀNH PHẦN, NỘI DUNG, THẢO LUẬN, KẾT LUẬN)
  function renderQuickReport() {
    const firstMeeting = state.meetings[0];
    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Báo cáo nhanh Bí thư</span>
        </div>
      </div>

      <div class="underline-tabs">
        <button class="u-tab ${state.quickReportTab === "create" ? "active" : ""}" onclick="App.setQuickReportTab('create')">
          Soạn báo cáo mới
        </button>
        <button class="u-tab ${state.quickReportTab === "list" ? "active" : ""}" onclick="App.setQuickReportTab('list')">
          Đã lưu <span class="tab-count">${state.quickReports.length}</span>
        </button>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        ${
          state.quickReportTab === "create"
            ? `
          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Lấy nhanh từ buổi sinh hoạt (tự động điền)</div>
            <select id="qrpt-meeting-select" class="form-control" onchange="App.prefillQuickReport(this.value)">
              <option value="">-- Chọn buổi sinh hoạt để tự động điền --</option>
              ${state.meetings
                .map(
                  (m) => `<option value="${m.id}">${escHtml(m.title)} (${m.attendees}/${m.totalTarget} ĐV)</option>`
                )
                .join("")}
            </select>
          </div>

          <div class="card">
            <div class="form-group">
              <label class="form-label">Tiêu đề báo cáo <span class="req">*</span></label>
              <input id="qrpt-title" class="form-control" value="${firstMeeting ? "Báo cáo nhanh " + escHtml(firstMeeting.title) : ""}" />
            </div>
            <div class="form-group">
              <label class="form-label">1. Thời gian <span class="req">*</span></label>
              <input id="qrpt-time" class="form-control" value="${escHtml(firstMeeting?.time)}" />
            </div>
            <div class="form-group">
              <label class="form-label">2. Địa điểm <span class="req">*</span></label>
              <input id="qrpt-location" class="form-control" value="${escHtml(firstMeeting?.location)}" />
            </div>
            <div class="form-group">
              <label class="form-label">3. Thành phần tham dự <span class="req">*</span></label>
              <textarea id="qrpt-attendees" class="form-control" rows="2">${firstMeeting ? `${firstMeeting.attendees}/${firstMeeting.totalTarget} đoàn viên` : ""}</textarea>
            </div>
            <div class="form-group">
              <label class="form-label">4. Nội dung họp <span class="req">*</span></label>
              <textarea id="qrpt-agenda" class="form-control" rows="3" placeholder="Liệt kê các nội dung chính triển khai trong buổi họp..."></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">5. Thảo luận <span class="req">*</span></label>
              <textarea id="qrpt-discussion" class="form-control" rows="3" placeholder="Tóm tắt các ý kiến đóng góp của đoàn viên..."></textarea>
            </div>
            <div class="form-group">
              <label class="form-label">6. Kết luận <span class="req">*</span></label>
              <textarea id="qrpt-conclusion" class="form-control" rows="3" placeholder="Các nội dung thống nhất, phân công nhiệm vụ và thời hạn..."></textarea>
            </div>

            <button class="btn-primary" onclick="App.saveQuickReport()" style="margin-bottom:8px;">
              ✓ Lưu báo cáo nhanh
            </button>
            <button class="btn-outline" style="width:100%;" onclick="App.saveQuickReport(true)">
              ${icon("print")} Lưu & In / Xuất PDF ngay
            </button>
          </div>
        `
            : state.quickReports
                .map(
                  (r) => `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <span class="status-chip live">Đã lưu · ${escHtml(r.createdAt)}</span>
                <span style="font-size:11.5px;color:var(--primary);font-weight:700;">${escHtml(r.createdBy)}</span>
              </div>
              <div style="font-size:15px;font-weight:800;margin-bottom:8px;">${escHtml(r.title)}</div>

              <div class="qrpt-block"><strong>1. Thời gian</strong>${escHtml(r.time)}</div>
              <div class="qrpt-block"><strong>2. Địa điểm</strong>${escHtml(r.location)}</div>
              <div class="qrpt-block"><strong>3. Thành phần tham dự</strong>${escHtml(r.attendees)}</div>
              <div class="qrpt-block"><strong>4. Nội dung họp</strong>${escHtml(r.agenda).replace(/\n/g, "<br>")}</div>
              <div class="qrpt-block"><strong>5. Thảo luận</strong>${escHtml(r.discussion).replace(/\n/g, "<br>")}</div>
              <div class="qrpt-block"><strong>6. Kết luận</strong>${escHtml(r.conclusion).replace(/\n/g, "<br>")}</div>

              <div style="display:flex;gap:8px;margin-top:10px;">
                <button class="btn-primary" style="padding:9px;font-size:12.5px;" onclick="App.printSavedQuickReport('${r.id}')">${icon("print")} In / Lưu PDF</button>
                <button class="btn-outline" style="flex:1;padding:9px;font-size:12.5px;" onclick="App.copyQuickReportText('${r.id}')">${icon("file")} Sao chép gửi Zalo</button>
              </div>
            </div>
          `
                )
                .join("")
        }
      </div>
    `;
  }

  // 4. MÀN HÌNH ĐOÀN VIÊN QUÉT QR ĐIỂM DANH & LỊCH SỬ THAM GIA
  function renderScan() {
    const liveMeeting = state.meetings.find(m => m.status === "Đang điểm danh");
    const memberId = state.currentRoleId === "member" ? linkedMemberId() : state.scanMemberId;
    const roster = canManage() ? work.scanRoster(state.members) : state.members;
    const memberObj = roster.find(m => m.id === memberId);
    const cameraAvailable = typeof window.AndroidBridge?.scanQr === "function";

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Quét QR & Lịch sử tham gia</span>
        </div>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        <div class="qr-scanner-box">
          <div class="form-label">Đoàn viên điểm danh</div>
          ${state.currentRoleId === "member" ? escHtml(getCurrentRole().userName) :
            `<select class="form-control" onchange="App.selectScanMember(this.value)"><option value="">Chọn đoàn viên</option>${roster.map(m =>
              `<option value="${m.id}" ${memberId === m.id ? "selected" : ""}>${escHtml(m.name)} · ${escHtml(m.phone)}</option>`).join("")}</select>`}
          <p>${liveMeeting ? escHtml(liveMeeting.title) : "Chưa có buổi sinh hoạt đang mở."}</p>

          ${cameraAvailable
            ? `<button class="btn-primary" onclick="App.scanMeetingQr()">${icon("camera")} Mở camera quét QR</button>`
            : '<div>Nhập mã do Bí thư cung cấp để điểm danh.</div>'}
        </div>

        <div class="card">
          <label class="form-label">Hoặc nhập mã điểm danh (nếu camera mờ)</label>
          <div style="display:flex;gap:8px;">
            <input id="manual-qr-input" class="form-control" placeholder="Nhập mã của buổi sinh hoạt" autocomplete="off" />
            <button class="btn-primary" style="width:auto;white-space:nowrap;padding:0 16px;" onclick="App.performCheckIn(document.getElementById('manual-qr-input').value)">
              Xác nhận
            </button>
          </div>
        </div>

        <div class="section-header">
          <h3>Lịch sử tham gia (${escHtml(memberObj?.name || (canManage() ? "Chưa chọn đoàn viên" : getCurrentRole().userName))})</h3>
          <span style="font-size:12px;font-weight:700;color:var(--primary);">${totalPoints(memberObj,canManage() ? work.rosterKey(memberObj) : firebaseSession?.uid)} điểm TĐ</span>
        </div>

        ${state.meetings
          .map((m) => {
            const checked = m.attendedMemberIds.includes(m.cloud ? (canManage() ? work.rosterKey(memberObj) : firebaseSession.uid) : memberId);
            return `
            <div class="card" style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
              <div>
                <div style="font-size:13.5px;font-weight:700;">${escHtml(m.title)}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${icon("clock")} ${escHtml(m.time)}</div>
              </div>
              <span class="member-badge ${checked ? "badge-local" : "badge-far"}">
                ${checked ? `✓ Đã điểm danh (+${m.points}đ)` : "Làm ca / Vắng"}
              </span>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
  }

  // 5. MÀN HÌNH DANH SÁCH ĐOÀN VIÊN CÓ BỘ LỌC (46+ ĐOÀN VIÊN)
  function canMatchMembers() {
    return firebaseSession && canManage();
  }

  function registrationLabel(name, phone) {
    if (!directoryByPhone) return "Chưa đối chiếu";
    const matches = directoryByPhone.get(DoanFeatures.phoneKey(phone));
    if (!matches) return "Chưa tìm thấy đăng ký theo SĐT";
    if (matches.length > 1) return "Cần kiểm tra · nhiều tài khoản cùng SĐT";
    const cleanName = value => value.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("vi");
    if (cleanName(matches[0]) !== cleanName(name)) return "Cần kiểm tra · tài khoản mang tên " + matches[0];
    return "Đã đăng ký";
  }

  function registrationBadge(member) {
    if (member.accountUid) return `<span>${member.rosterPhone || !member.id.startsWith("uid-") ? "Đã khớp danh sách Bí thư" : "Đã đăng ký · chưa khớp danh sách Bí thư"}</span>`;
    return `<span data-match-name="${escHtml(member.name)}" data-match-phone="${escHtml(member.phone)}">${escHtml(registrationLabel(member.name, member.phone))}</span>`;
  }

  function directoryControls() {
    if (!canMatchMembers()) return "";
    return `<div class="card"><button type="button" class="btn-outline" onclick="App.refreshRegistrations()">Đối chiếu lại đăng ký</button>
      <p id="registration-directory-status" role="status">${escHtml(directoryMessage)}</p></div>`;
  }

  function updateRegistrationLabels() {
    const status = document.getElementById("registration-directory-status");
    if (!status) return;
    status.textContent = directoryMessage;
    document.querySelectorAll("[data-match-phone]").forEach(label => {
      label.textContent = registrationLabel(label.dataset.matchName, label.dataset.matchPhone);
    });
  }

  function renderMembers() {
    if (!canManage()) {
      const own = work.own;
      return `<div class="page-header"><button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
        <span class="page-title">Danh sách ĐV (${work.counts?.total ?? "…"})</span></div>
        <div class="section-wrap"><p>${work.counts ? "Số đoàn viên theo lần đồng bộ của cán bộ đơn vị." : "Đang chờ cán bộ đồng bộ số đoàn viên."}</p>
        ${own ? `<div class="card"><h3>Thông tin Đoàn viên của bạn</h3>${profileDetails(own)}
          <button class="btn-outline" onclick="App.editProfile('${own.id}')">Cập nhật hồ sơ</button></div>` : ""}</div>`;
    }
    const roster = work.scanRoster(state.members);
    const counts = getMemberCounts(roster);
    const filtered = roster.filter((m) => {
      const matchFilter = state.memberFilter === "all" || m.status === state.memberFilter;
      const q = state.memberSearch.trim().toLowerCase();
      const matchSearch =
        !q || m.name.toLowerCase().includes(q) || m.phone.includes(q) || m.job.toLowerCase().includes(q);
      return matchFilter && matchSearch;
    });

    const statusLabel = {
      local: { text: "Đang ở địa phương", cls: "badge-local" },
      far: { text: "Đi làm xa", cls: "badge-far" },
      transfer: { text: "Chuyển sinh hoạt", cls: "badge-transfer" }
    };

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Danh sách ĐV (${counts.total})</span>
        </div>
        <button class="btn-sm" style="background:var(--primary-light);color:var(--primary);" onclick="App.go('import_csv')">
          ${icon("download")} Nhập CSV
        </button>
      </div>

      <div class="search-bar">
        <div class="search-input-wrap">
          ${icon("search")}
          <input type="text" placeholder="Tìm tên, SĐT, công việc..." value="${escHtml(state.memberSearch)}" data-search="Member" oninput="if (!event.isComposing) App.setMemberSearch(this.value)" oncompositionend="App.setMemberSearch(this.value)" />
        </div>
      </div>

      <div class="filter-pills">
        <button class="pill ${state.memberFilter === "all" ? "active" : ""}" onclick="App.setMemberFilter('all')">Tất cả (${counts.total})</button>
        <button class="pill ${state.memberFilter === "local" ? "active" : ""}" onclick="App.setMemberFilter('local')">Ở địa phương (${counts.local})</button>
        <button class="pill ${state.memberFilter === "far" ? "active" : ""}" onclick="App.setMemberFilter('far')">Đi làm xa (${counts.far})</button>
        <button class="pill ${state.memberFilter === "transfer" ? "active" : ""}" onclick="App.setMemberFilter('transfer')">Chuyển SH (${counts.transfer})</button>
      </div>

      <div class="section-wrap">
        <div style="font-size:12px;color:var(--text-muted);margin:0 4px 8px;">
          ${directoryControls()}
          Hiển thị <strong>${filtered.length}</strong> đoàn viên · Bấm vào đoàn viên để xem hồ sơ hoạt động & trạng thái
        </div>
        ${filtered
          .map((m) => {
            const initials = m.name.split(" ").slice(-2).map((w) => w[0]).join("");
            const st = statusLabel[m.status] || {cls:"badge-local",text:"Chưa cập nhật trạng thái"};
            return `
            <div class="member-row" onclick="App.openMemberModal('${m.id}')">
              <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                <div class="member-avatar">${escHtml(initials)}</div>
                <div style="min-width:0;">
                  <div style="font-size:14px;font-weight:700;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(m.name)}</div>
                  <div style="font-size:12px;color:var(--text-muted);">${escHtml(m.group)} · ${escHtml(m.job)}</div>
                  <div style="font-size:11.5px;color:#6B7280;">${icon("phone")} ${escHtml(m.phone || "Chưa cập nhật SĐT")} · ${icon("star")} ${totalPoints(m,work.rosterKey(m))}đ</div>
                  ${canMatchMembers() ? registrationBadge(m) : ""}
                </div>
              </div>
              <span class="member-badge ${st.cls}">${st.text}</span>
            </div>
          `;
          })
          .join("")}
      </div>
    `;
  }

  // 6. MÀN HÌNH TỔNG HỢP CỦA ĐOÀN XÃ, PHƯỜNG + THỐNG KÊ 6 NHÓM + IN PDF HÀNH CHÍNH
  function wardReport() {
    const meetings = state.meetings.filter(m => m.dateIso?.slice(0, 7) === state.wardMonth);
    return [["Buổi sinh hoạt", "Ngày", "Lượt tham dự", "Số dự kiến"],
      ...meetings.map(m => [m.title, m.dateIso, m.attendees, m.totalTarget])];
  }

  function renderWard() {
    const [, ...rows] = wardReport();
    const counts = getMemberCounts();
    return `<div class="page-header"><button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
      <span class="page-title">Tổng hợp sinh hoạt</span></div><div class="section-wrap">
      <div class="card"><h3>${escHtml(getCurrentRole().unit)}</h3><p>${counts.total} đoàn viên trong danh sách</p>
      ${state.currentRoleId === "ward_officer" ? work.secretaries.map(person=>`<p>Bí thư: ${escHtml(person.name)} · ${escHtml(person.phone || "Chưa cập nhật SĐT")}</p>`).join("") : ""}
      <label class="form-label">Tháng báo cáo<input class="form-control" type="month" value="${state.wardMonth}" onchange="App.setWardMonth(this.value)"></label>
      <p>${rows.length} buổi · ${rows.reduce((sum, row) => sum + row[2], 0)} lượt tham dự</p>
      ${rows.map(([title, date, attended, target]) => `<p>${escHtml(date)} · ${escHtml(title)} · ${attended}/${target}</p>`).join("") || "Chưa có buổi sinh hoạt trong tháng."}
      </div><button class="btn-primary" onclick="App.printOfficialWardReport()">In / Lưu PDF</button>
      <button class="btn-outline" onclick="App.exportWardCSV()">Xuất CSV</button></div>`;
  }

  // 7. ĐIỂM CỘNG 1: SINH HOẠT BÙ
  function renderMakeup() {
    const shifts = ["Ca sáng (06h-14h)", "Ca chiều (14h-22h)", "Ca đêm (22h-06h)"];
    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Sinh hoạt bù (Làm ca KCN)</span>
        </div>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        <div class="card">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Ca làm việc tuần này của bạn</div>
          <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">Hệ thống tự động gợi ý lịch sinh hoạt bù không trùng ca tại KCN.</p>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            ${shifts
              .map(
                (s) => `
              <button class="pill ${state.workerShift === s ? "active" : ""}" onclick="App.setWorkerShift('${s}')">${s}</button>
            `
              )
              .join("")}
          </div>
        </div>

        <div class="section-header">
          <h3>Lịch sinh hoạt bù phù hợp</h3>
          ${state.currentRoleId === "member" ? "" : '<button class="btn-sm" onclick="App.openEntryForm(\'makeup\')">+ Tạo buổi bù</button>'}
        </div>

        ${state.makeupSessions.filter(ms => ms.registered || !conflictsWithShift(ms.time, state.workerShift, ms.endTime))
          .map(
            (ms) => `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
              <span class="status-chip ${ms.registered ? "live" : "upcoming"}">${ms.registered ? "✓ Đã đăng ký" : "Còn " + ms.slotsLeft + " chỗ"}</span>
            </div>
            <div style="font-size:14.5px;font-weight:700;margin:8px 0 4px;">${escHtml(ms.title)}</div>
            <div style="font-size:12.5px;color:#4B5563;margin-bottom:3px;">${icon("work")} ${conflictsWithShift(ms.time, state.workerShift, ms.endTime) ? "Đã đăng ký · trùng ca hiện tại" : "Ngoài ca làm việc đã chọn"}</div>
            <div style="font-size:12.5px;color:#4B5563;margin-bottom:3px;">${icon("clock")} Thời gian: ${escHtml(ms.time)}${ms.endTime ? " – " + escHtml(ms.endTime) : ""}</div>
            <div style="font-size:12.5px;color:#4B5563;margin-bottom:12px;">${icon("pin")} Địa điểm: ${escHtml(ms.location)}</div>
            <button class="${ms.registered ? "btn-outline" : "btn-primary"}" style="width:100%;padding:10px;" onclick="App.toggleMakeup('${ms.id}')">
              ${ms.registered ? "Hủy đăng ký buổi bù này" : "Đăng ký sinh hoạt bù"}
            </button>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  // 8. ĐIỂM CỘNG 3: TÍCH ĐIỂM THI ĐUA TÌNH NGUYỆN
  function renderPoints() {
    const me = state.members.find(m => m.id === linkedMemberId());
    const myPoints = totalPoints(me,firebaseSession?.uid);
    const topMembers = work.scanRoster(state.members).map(m => ({...m, points:totalPoints(m,work.rosterKey(m))})).sort((a,b) => b.points-a.points).slice(0,5);

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Chấm công & Tích điểm tình nguyện</span>
        </div>
        <button class="btn-sm" style="background:var(--primary-light);color:var(--primary);" onclick="App.go('achievements')">${icon("award")} Thành tích</button>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        <div class="card" style="background:linear-gradient(135deg,#059669,#10B981);color:#fff;">
          <div style="font-size:12px;opacity:0.9;">ĐIỂM THI ĐUA TÍCH LŨY · ${escHtml(getCurrentRole().userName)}</div>
          <div style="display:flex;align-items:baseline;gap:8px;margin:6px 0;">
            <span style="font-size:34px;font-weight:800;">${myPoints}</span>
            <span style="font-size:14px;">điểm</span>
          </div>
          <div style="font-size:12.5px;background:rgba(255,255,255,0.18);padding:6px 10px;border-radius:10px;display:inline-block;">
            ${icon("award")} Danh hiệu: ${myPoints >= 100 ? "Đoàn viên Tiêu biểu Xuất sắc" : "Chưa xếp loại"}
          </div>
        </div>

        <div class="section-header">
          <h3>Hoạt động tình nguyện tích điểm</h3>
          ${state.currentRoleId === "member" ? "" : '<button class="btn-sm" onclick="App.openEntryForm(\'points\')">+ Tạo hoạt động</button>'}
        </div>

        ${state.volunteerActivities
          .map(
            (va) => `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <span class="status-chip ${va.completed ? "live" : "upcoming"}">${va.completed ? "✓ Đã nhận +" + va.points + "đ" : "+" + va.points + " điểm thi đua"}</span>
            </div>
            <div style="font-size:14.5px;font-weight:700;margin:8px 0 4px;">${escHtml(va.title)}</div>
            <div style="font-size:12.5px;color:var(--text-muted);">${icon("clock")} ${escHtml(va.time)}</div>
            <div style="font-size:12.5px;color:var(--text-muted);margin-bottom:10px;">${icon("pin")} ${escHtml(va.location)}</div>
            <button class="${va.completed ? "btn-outline" : "btn-primary"}" style="width:100%;padding:10px;" ${va.completed ? "disabled" : ""} onclick="App.completeVolunteer('${va.id}')">
              ${va.completed ? "Đã check-in & cộng điểm" : "Đăng ký & Check-in nhận +" + va.points + " điểm"}
            </button>
          </div>
        `
          )
          .join("")}

        <div class="section-header">
          <h3>Bảng xếp hạng đơn vị</h3>
        </div>
        <div class="card" style="padding:8px 14px;">
          ${topMembers
            .map(
              (m, i) => `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #F3F4F6;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span style="width:22px;height:22px;border-radius:50%;background:${i === 0 ? "#F59E0B" : "#E5E7EB"};color:${i === 0 ? "#fff" : "#374151"};font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;">${i + 1}</span>
                <span style="font-size:13.5px;font-weight:600;">${escHtml(m.name)}</span>
              </div>
              <strong style="color:var(--primary);font-size:13.5px;">${m.points} đ</strong>
            </div>
          `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  // 9. ĐIỂM CỘNG 2: NHẮC LỊCH TỰ ĐỘNG
  function renderReminders() {

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Thông báo</span>
        </div>

      </div>

      <div class="section-wrap" style="margin-top:12px;">
        ${profileInbox()}
        ${state.notifications.length ? "" : '<div class="card">Chưa có thông báo.</div>'}

        <div class="section-header">
          <h3>Thông báo nhắc lịch gần đây</h3>
          <button class="section-link" onclick="App.markAllRead()">Đánh dấu đã đọc</button>
        </div>

        ${state.notifications
          .map(
            (n) => `
          <div class="card" style="border-left:${n.unread ? "4px solid var(--accent)" : "4px solid transparent"};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <strong style="font-size:13.5px;">${escHtml(n.title)}</strong>
            </div>
            <div style="font-size:12.5px;color:#4B5563;line-height:1.4;margin-bottom:6px;">${escHtml(n.desc)}</div>
            <div style="font-size:11px;color:var(--text-muted);">${icon("clock")} ${escHtml(n.time)}</div>
            ${n.action === "createMakeup" && canManage() ? '<button class="btn-outline" onclick="App.openEntryForm(\'makeup\')">Tạo lịch sinh hoạt bù</button>' : ""}
            ${["account","register","approvals","points","news"].includes(n.action) ? `<button class="btn-outline" onclick="App.go('${n.action}')">Xem ${{account:"hồ sơ",register:"đăng ký",approvals:"hồ sơ chờ duyệt",points:"hoạt động",news:"bảng tin"}[n.action]}</button>` : ""}
            ${n.action === "makeup" ? '<button class="btn-outline" onclick="App.go(\'makeup\')">Xem lịch sinh hoạt bù</button>' : ""}
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  // Góp ý được gửi theo đơn vị; đoàn viên chỉ xem nội dung của mình.
  let feedbackDraft = null;
  let feedbackBusy = false;
  function currentFeedbackDraft() {
    const scope = firebaseSession?.uid + "/" + firebaseSession?.unitCode;
    if (feedbackDraft?.scope !== scope) feedbackDraft = {scope, id:work.newId(), title:"", body:""};
    return feedbackDraft;
  }
  function renderFeedback() {
    const role = getCurrentRole(), draft = currentFeedbackDraft();
    const items = work.feedback.slice().sort((a,b) => b.at - a.at);
    return `
      <div class="page-header"><div class="page-header-left">
        <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
        <span class="page-title">${canManage() ? "Tiếp nhận & đóng góp ý kiến" : "Đóng góp ý kiến"}</span>
      </div></div>
      <div class="section-wrap" style="margin-top:12px;">
        <form class="card" onsubmit="event.preventDefault();App.submitFeedback()">
          <p>Người gửi: <strong>${escHtml(role.userName)}</strong></p>
          <p>Đơn vị tiếp nhận: ${escHtml(role.unit)}</p>
          <div class="form-group">
            <label class="form-label" for="fb-title">Tiêu đề góp ý <span class="req">*</span></label>
            <input id="fb-title" class="form-control" maxlength="120" required
              value="${escHtml(draft.title)}" ${feedbackBusy ? "disabled" : ""}
              oninput="App.updateFeedbackDraft('title',this.value)" placeholder="Nhập tiêu đề góp ý" />
          </div>
          <div class="form-group">
            <label class="form-label" for="fb-body">Nội dung góp ý <span class="req">*</span></label>
            <textarea id="fb-body" class="form-control" rows="4" maxlength="4000" required
              ${feedbackBusy ? "disabled" : ""} oninput="App.updateFeedbackDraft('body',this.value)"
              placeholder="Nhập nội dung góp ý hoặc đề xuất">${escHtml(draft.body)}</textarea>
          </div>
          <button class="btn-accent" ${feedbackBusy ? "disabled" : ""}>${feedbackBusy ? "Đang gửi…" : "Gửi góp ý"}</button>
        </form>
        <div class="section-header"><h3>${canManage() ? "Góp ý của đơn vị" : "Góp ý đã gửi"}</h3></div>
        ${!work.feedbackReady ? '<p class="card">Đang tải góp ý…</p>' : !items.length ? '<p class="card">Chưa có góp ý.</p>' : ""}
        ${items.map(item => `<section class="card">
          <strong>${escHtml(item.title)}</strong>
          <p>${escHtml(item.name)} · ${escHtml(new Date(item.at).toLocaleString("vi-VN"))}</p>
          <p style="white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0;">${escHtml(item.body)}</p>
          <span class="status-chip ${item.status === "received" ? "live" : "warn"}">${item.status === "received" ? "Đã tiếp nhận" : "Chờ tiếp nhận"}</span>
          ${canManage() && item.status === "pending" && /^[a-f0-9]{24}$/.test(item.id)
            ? `<button class="btn-outline" onclick="App.receiveFeedback('${item.id}',this)">Ghi nhận đã tiếp nhận</button>` : ""}
        </section>`).join("")}
      </div>`;
  }

  // 11. TÀI KHOẢN / CÁ NHÂN
  function linkedMemberId(roleId = state.currentRoleId) {

    const role = state.roles.find(r => r.id === roleId);
    return role?.phone && state.members.find(m => m.phone === role.phone)?.id;
  }
  const profileFields = {
    name: "Họ tên", birthDate: "Ngày tháng năm sinh", ethnicity: "Dân tộc",
    religion: "Tôn giáo", cardNo: "Số thẻ Đoàn", citizenId: "Số căn cước",
    address: "Địa chỉ", unit: "Nơi sinh hoạt Đoàn", phone: "Số điện thoại", status: "Trạng thái sinh hoạt"
  };
  const memberStatuses = { local:"Ở địa phương", far:"Đi làm xa", transfer:"Chuyển sinh hoạt" };
  const legacyFields = { phone: "Điện thoại", job: "Nghề nghiệp" };

  function findProfile(id) {
    if (work.own?.id === id) return work.own;
    if (canManage()) return work.scanRoster(state.members).find(m => m.id === id);
    return state.members.find(m => m.id === id);
  }

  function memberProfile(member) {
    const role = state.roles.find(r => linkedMemberId(r.id) === member.id);
    return { ...member, cardNo: member.cardNo ?? role?.cardNo ?? "", unit: member.unit ?? role?.unit ?? "" };
  }

  function profileDisplay(key, value, birthYear) {
    if (!value && key === "birthDate" && birthYear) return "Năm " + escHtml(birthYear);
    if (!value) return "Chưa cập nhật";
    if (key === "status") return memberStatuses[value] || "Chưa cập nhật";
    if (key === "birthDate") return escHtml(value.split("-").reverse().join("/"));
    return escHtml(value);
  }

  function profileDetails(member) {
    if (!member || !canEditProfile(member.id)) return "";
    const values = memberProfile(member);
    return `<dl class="profile-details">${Object.entries(profileFields).map(([key, label]) =>
      `<div><dt>${label}</dt><dd>${profileDisplay(key, values[key], values.birthYear)}</dd></div>`).join("")}</dl>`;
  }

  function canEditProfile(id) {
    return canManage() || (state.currentRoleId === "member" && work.own?.id === id);
  }

  function applyProfile(member, values) {
    const role = state.roles.find(r => linkedMemberId(r.id) === member.id);
    Object.assign(member, values);
    if ("birthDate" in values) member.birthYear = values.birthDate ? Number(values.birthDate.slice(0, 4)) : "";
    if (role) {
      role.userName = member.name.toLocaleUpperCase("vi");
      role.avatarText = role.userName.split(/\s+/).slice(-2).map(part => part[0]).join("");
      role.phone = member.phone;
      if ("cardNo" in values) role.cardNo = values.cardNo;
      if ("unit" in values) role.unit = values.unit;
      if ("unit" in values || "birthDate" in values) role.subtitle = [role.roleName, role.unit].filter(Boolean).join(" · ");
    }
    for (const record of [...state.registrations, ...state.evidences]) {
      if (record.memberId !== member.id) continue;
      record.submitterName = member.name;
      if ("unit" in values && "unitName" in record && record.registrationType !== "collective") record.unitName = values.unit;
      if ("phone" in record) record.phone = member.phone;
    }
    for (const award of state.personalAchievements) {
      if (award.memberId === member.id) award.memberName = member.name;
    }
  }

  function profileInbox() {
    if (!canManage()) return "";
    const remote = work.requests.filter(r => r.status === "pending" && /^[\w-]+$/.test(r.owner)).map(r => {
      const member = work.scanRoster(state.members).find(m=>m.accountUid === r.owner);
      const diffs = Object.entries(r.changes).filter(([k])=>Object.hasOwn(profileFields,k)).map(([k,v])=>
        `<p>${profileFields[k]}: ${profileDisplay(k,member?.[k])} → ${profileDisplay(k,v)}</p>`).join("");
      return `<section class="card"><strong>Yêu cầu sửa hồ sơ · ${escHtml(member?.name || r.owner)}</strong>${diffs}
        <button class="btn-primary" onclick="App.decideProfile('${r.owner}','${r.version}',true)">Phê duyệt</button>
        <button class="btn-outline" onclick="App.decideProfile('${r.owner}','${r.version}',false)">Từ chối</button></section>`;
    }).join("");
    return remote + Object.entries(state.profileRequests).map(([id, changes]) => {
      const member = state.members.find(m => m.id === id);
      if (!member) return "";
      const current = memberProfile(member);
      return `<section class="card"><strong>Yêu cầu cập nhật · ${escHtml(member.name)}</strong>
        ${Object.entries(changes).map(([key, value]) => `<p>${profileFields[key] || legacyFields[key]}: ${profileDisplay(key, current[key], current.birthYear)} → ${profileDisplay(key, value)}</p>`).join("")}
        <button class="btn-primary" onclick="App.reviewProfile('${id}', true)">Phê duyệt</button>
        <button class="btn-outline" onclick="App.reviewProfile('${id}', false)">Từ chối</button></section>`;
    }).join("");
  }

  function renderAccount() {
    const role = getCurrentRole();
    const localMember = state.members.find(m => m.id === linkedMemberId(role.id));
    const member = work.own ? {...localMember,...work.own} : localMember;
    const request = work.requests.find(r => r.owner === firebaseSession?.uid);
    return `
      <div class="page-header">
        <div class="page-header-left">
          <span class="page-title">Cá nhân</span>
        </div>
      </div>

      <div class="section-wrap account-page" style="margin-top:12px;">
        <div class="card account-summary">
          <div class="avatar-circle" style="background:${role.color};width:54px;height:54px;border:none;">${escHtml(role.avatarText)}</div>
          <div>
            <div style="font-size:16px;font-weight:800;">${escHtml(role.userName)}</div>
            <div class="account-subtitle">${escHtml(role.subtitle)}</div>
            <div class="account-card-number">${escHtml(member?.cardNo || "")}</div>
            <strong>${totalPoints(localMember,firebaseSession?.uid)} điểm thi đua tích lũy</strong>
          </div>
        </div>

        <div class="menu-list-card">
          <div class="menu-list-title">Hồ sơ & Hoạt động</div>
          ${role.id === "member" ? `<button class="menu-row" onclick="App.go('scan')"><span class="menu-row-icon bg-pastel-purple">${icon("qr")}</span>Điểm danh sinh hoạt</button>` : ""}
          <button class="menu-row" onclick="DoanManagement.account()"><span class="menu-row-icon bg-pastel-blue">${icon("edit")}</span>Đổi email / mật khẩu</button>
          ${canManage() ? `<button class="menu-row" onclick="DoanManagement.units()"><span class="menu-row-icon bg-pastel-teal">${icon("users")}</span>Quản lý chi đoàn</button>` : ""}
          ${firebaseSession && role.id === "member" ? `<form class="profile-form" onsubmit="event.preventDefault();App.saveMemberPhone(this)">
            <label class="form-label">Số điện thoại đối chiếu với danh sách chi đoàn<input class="form-control" name="phone" type="tel" autocomplete="tel" required value="${escHtml(role.phone || "")}"></label>
            <button class="btn-outline" ${savingPhone ? "disabled" : ""}>Lưu số điện thoại</button></form>` : ""}
          ${profileDetails(member)}
          ${work.own ? `<button class="menu-row" onclick="App.editProfile('${work.own.id}')"><span class="menu-row-icon">${icon("edit")}</span>${canManage() ? "Chỉnh sửa thông tin cá nhân" : "Gửi yêu cầu sửa thông tin cá nhân"}</button>` : "<p>Đang tải hồ sơ tài khoản…</p>"}
          ${request ? `<p>Yêu cầu sửa hồ sơ: ${{pending:"Chờ phê duyệt",approved:"Đã phê duyệt",rejected:"Đã từ chối"}[request.status]}.</p>` : ""}
          ${canManage() ? `<button class="menu-row" onclick="App.go('members')"><span class="menu-row-icon bg-pastel-blue">${icon("users")}</span><span style="flex:1;text-align:left">Quản lý hồ sơ đoàn viên</span><span aria-hidden="true">›</span></button>` : ""}
          ${profileInbox()}
          <div class="menu-row" onclick="App.go('quick_report')">
            <div class="menu-row-icon bg-pastel-teal">${icon("file")}</div>
            <span class="account-menu-label">Báo cáo nhanh sinh hoạt (Bí thư)</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('register')">
            <div class="menu-row-icon bg-pastel-blue">${icon("edit")}</div>
            <span class="account-menu-label">Cổng đăng ký & Tra cứu mã hồ sơ</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('evidence')">
            <div class="menu-row-icon bg-pastel-purple">${icon("camera")}</div>
            <span class="account-menu-label">Nộp & theo dõi minh chứng hoạt động</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('achievements')">
            <div class="menu-row-icon bg-pastel-yellow">${icon("award")}</div>
            <span class="account-menu-label">Thành tích cá nhân & tập thể</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('calendar')">
            <div class="menu-row-icon bg-pastel-green">${icon("calendar")}</div>
            <span class="account-menu-label">Lịch hoạt động tháng</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
        </div>

        <div class="menu-list-card">
          <div class="menu-list-title">Quản trị & Tiện ích</div>
          <div class="menu-row" onclick="App.go('approvals')">
            <div class="menu-row-icon bg-pastel-orange">${icon("check")}</div>
            <span class="account-menu-label">Phê duyệt hồ sơ đăng ký</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('import_csv')">
            <div class="menu-row-icon bg-pastel-indigo">${icon("download")}</div>
            <span class="account-menu-label">Nhập danh sách đoàn viên (CSV)</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('audit')">
            <div class="menu-row-icon bg-pastel-teal">${icon("news")}</div>
            <span class="account-menu-label">Nhật ký hệ thống (Audit Logs)</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
          <div class="menu-row" onclick="App.go('feedback')">
            <div class="menu-row-icon bg-pastel-pink">${icon("msg")}</div>
            <span class="account-menu-label">${canManage() ? "Tiếp nhận & đóng góp ý kiến" : "Đóng góp ý kiến"}</span>
            <span style="color:#9CA3AF;">›</span>
          </div>
        </div>

        <div style="margin-top:16px;">
          <p>Bảng tin, lịch, điểm danh, đăng ký, minh chứng và yêu cầu sửa hồ sơ được đồng bộ theo đơn vị.</p>
          <button class="btn-outline" onclick="App.accountSettings()">
            Đăng xuất
          </button>
        </div>
      </div>
    `;
  }

  // 12. CỔNG ĐĂNG KÝ HOẠT ĐỘNG & TRA CỨU MÃ HỒ SƠ
  function renderRegister() {
    const openActs = state.activities.filter((a) => {
      const isOpen = a.status === "Đang mở đăng ký" && a.deadline >= localDate();
      const matchCat = state.registerCatFilter === "all" || a.category === state.registerCatFilter;
      return isOpen && matchCat;
    });

    const foundReg = state.registrations.find(
      (r) => r.profileCode.toUpperCase() === state.lookupCode.trim().toUpperCase()
    );

    const regStatusMap = {
      pending: { text: "Đang chờ duyệt", cls: "warn" },
      approved: { text: "✓ Đã phê duyệt", cls: "live" },
      rejected: { text: "✕ Từ chối", cls: "danger" }
    };

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Đăng ký & Tra cứu hồ sơ</span>
          ${state.currentRoleId === "member" ? "" : '<button class="btn-sm" onclick="App.openEntryForm(\'register\')">+ Tạo hoạt động</button>'}
        </div>
      </div>

      <div class="underline-tabs">
        <button class="u-tab ${state.registerTab === "open" ? "active" : ""}" onclick="App.setRegisterTab('open')">
          Hoạt động mở <span class="tab-count">${state.activities.filter(a => a.status === "Đang mở đăng ký" && a.deadline >= localDate()).length}</span>
        </button>
        <button class="u-tab ${state.registerTab === "lookup" ? "active" : ""}" onclick="App.setRegisterTab('lookup')">
          Tra cứu Mã HS <span class="tab-count">${state.registrations.length}</span>
        </button>
      </div>

      ${
        state.registerTab === "open"
          ? `
        <div class="filter-pills" style="padding-top:10px;">
          <button class="pill ${state.registerCatFilter === "all" ? "active" : ""}" onclick="App.setRegisterCat('all')">Tất cả (6 nhóm)</button>
          ${state.activityCategories
            .map(
              (c) => `
            <button class="pill ${state.registerCatFilter === c.name ? "active" : ""}" onclick="App.setRegisterCat('${c.name}')">${c.name}</button>
          `
            )
            .join("")}
        </div>
        <div class="section-wrap">
          ${openActs
            .map((a) => {
              const cat = getCategoryMeta(a.category);
              return `
              <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px;">
                  <span class="cat-badge" style="background:${cat.bg};color:${cat.color};">${escHtml(a.category)}</span>
                  <span style="font-size:12px;font-weight:700;color:var(--primary);">+${a.points} điểm</span>
                </div>
                <div style="font-size:14.5px;font-weight:700;margin-bottom:5px;">${escHtml(a.title)}</div>
                <div style="font-size:12.5px;color:#4B5563;line-height:1.4;margin-bottom:8px;">${escHtml(a.description)}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:3px;">${icon("calendar")} Diễn ra: <strong>${escHtml(a.date)}</strong> · Hạn ĐK: ${escHtml(a.deadline)}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:11px;">${icon("pin")} ${escHtml(a.location)}</div>
                <button class="btn-primary" style="padding:10px;" onclick="App.openRegisterModal('${a.id}')">
                  ${icon("edit")} Đăng ký & Nhận Mã hồ sơ
                </button>
              </div>
            `;
            })
            .join("")}
        </div>
      `
          : `
        <div class="section-wrap" style="margin-top:12px;">
          <div class="card">
            <label class="form-label">Nhập mã hồ sơ</label>
            <div style="display:flex;gap:8px;">
              <input id="lookup-code-input" class="form-control" value="${escHtml(state.lookupCode)}" placeholder="Mã trên phiếu đăng ký" />
              <button class="btn-primary" style="width:auto;padding:0 16px;" onclick="App.searchProfileCode()">Tra cứu</button>
            </div>
            <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;">
              ${state.registrations
                .slice(0, 4)
                .map(
                  (r) => `
                <button class="pill" style="font-size:11px;padding:4px 9px;" onclick="App.quickLookupCode('${r.profileCode}')">${r.profileCode}</button>
              `
                )
                .join("")}
            </div>
          </div>

          ${
            foundReg
              ? `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <strong style="font-family:monospace;font-size:15px;color:var(--primary);">${foundReg.profileCode}</strong>
                <span class="status-chip ${regStatusMap[foundReg.status].cls}">${regStatusMap[foundReg.status].text}</span>
              </div>
              <div style="font-size:14.5px;font-weight:700;margin-bottom:6px;">${escHtml(foundReg.activityTitle)}</div>
              <div style="font-size:12.5px;color:#374151;line-height:1.6;background:#F8FAFC;padding:10px;border-radius:10px;margin-bottom:10px;">
                <div>${icon("user")} Người đăng ký: <strong>${escHtml(foundReg.submitterName)}</strong></div>
                <div>${icon("home")} Đơn vị: ${escHtml(foundReg.unitName)}</div>
                <div>${icon("file")} Hình thức: ${foundReg.registrationType === "collective" ? "Tập thể Chi đoàn" : "Cá nhân Đoàn viên"}</div>
                <div>${icon("msg")} Ghi chú: ${escHtml(foundReg.notes || "Không có")}</div>
                ${foundReg.rejectReason ? `<div style="color:#DC2626;">${icon("warn")} Lý do từ chối: ${escHtml(foundReg.rejectReason)}</div>` : ""}
              </div>
              <div style="display:flex;gap:8px;">
                <button class="btn-outline" style="flex:1;" onclick="App.downloadReceipt('${foundReg.id}')">${icon("image")} Tải Phiếu PNG</button>
                ${
                  foundReg.status === "pending" && (!foundReg.cloud || foundReg.owner === firebaseSession?.uid)
                    ? `<button class="btn-danger" onclick="App.cancelRegistration('${foundReg.id}')">Hủy hồ sơ</button>`
                    : ""
                }
              </div>
            </div>
          `
              : `<div class="card" style="text-align:center;color:var(--text-muted);font-size:13px;">Không tìm thấy hồ sơ với mã <strong>${escHtml(state.lookupCode)}</strong>.</div>`
          }
        </div>
      `
      }
    `;
  }

  // 13. PHÊ DUYỆT ĐĂNG KÝ HOẠT ĐỘNG
  function renderApprovals() {
    const pendingCount = state.registrations.filter((r) => r.status === "pending").length;
    const filtered = state.registrations.filter(
      (r) => state.approvalFilter === "all" || r.status === state.approvalFilter
    );

    const stMap = {
      pending: { text: "Chờ duyệt", cls: "warn" },
      approved: { text: "Đã duyệt", cls: "live" },
      rejected: { text: "Từ chối", cls: "danger" }
    };

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Phê duyệt đăng ký (${pendingCount})</span>
        </div>
        ${
          pendingCount > 0
            ? `<button class="btn-sm" style="background:var(--success);color:#fff;" onclick="App.approveAllRegistrations()">Duyệt tất cả</button>`
            : ""
        }
      </div>

      <div class="filter-pills" style="padding-top:10px;">
        <button class="pill ${state.approvalFilter === "all" ? "active" : ""}" onclick="App.setApprovalFilter('all')">Tất cả (${state.registrations.length})</button>
        <button class="pill ${state.approvalFilter === "pending" ? "active" : ""}" onclick="App.setApprovalFilter('pending')">Chờ duyệt (${pendingCount})</button>
        <button class="pill ${state.approvalFilter === "approved" ? "active" : ""}" onclick="App.setApprovalFilter('approved')">Đã duyệt (${state.registrations.filter((r) => r.status === "approved").length})</button>
        <button class="pill ${state.approvalFilter === "rejected" ? "active" : ""}" onclick="App.setApprovalFilter('rejected')">Từ chối (${state.registrations.filter((r) => r.status === "rejected").length})</button>
      </div>

      <div class="section-wrap">
        ${filtered
          .map(
            (r) => `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <span style="font-family:monospace;font-size:12.5px;font-weight:700;color:var(--primary);">${r.profileCode}</span>
              <span class="status-chip ${stMap[r.status].cls}">${stMap[r.status].text}</span>
            </div>
            <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${escHtml(r.activityTitle)}</div>
            <div style="font-size:12.5px;color:#374151;margin-bottom:3px;">${icon("user")} <strong>${escHtml(r.submitterName)}</strong> · ${escHtml(r.unitName)}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">${icon("msg")} ${escHtml(r.notes || "Không có ghi chú")}</div>
            ${r.rejectReason ? `<div style="font-size:12px;color:#DC2626;margin-bottom:8px;">Lý do: ${escHtml(r.rejectReason)}</div>` : ""}
            ${
              r.status === "pending"
                ? `
              <div style="display:flex;gap:8px;">
                <button class="btn-success" style="flex:1;" onclick="App.approveRegistration('${r.id}')">✓ Phê duyệt</button>
                <button class="btn-danger" style="flex:1;" onclick="App.openRejectModal('${r.id}')">✕ Từ chối</button>
              </div>
            `
                : `<button class="btn-outline" style="width:100%;padding:7px;font-size:12px;" onclick="App.downloadReceipt('${r.id}')">${icon("image")} Xem / Tải Phiếu PNG</button>`
            }
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  // 14. NỘP & DUYỆT MINH CHỨNG HOẠT ĐỘNG
  function renderEvidence() {
    const filtered = state.evidences.filter(
      (e) => state.evidenceFilter === "all" || e.status === state.evidenceFilter
    );
    const stMap = {
      pending: { text: "Chờ xác nhận", cls: "warn" },
      verified: { text: "✓ Đã xác nhận", cls: "live" },
      revision: { text: "Cần bổ sung", cls: "danger" }
    };

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Minh chứng hoạt động</span>
        </div>
        <button class="btn-sm" style="background:var(--primary);color:#fff;" onclick="App.openSubmitEvidenceModal()">+ Nộp MC</button>
      </div>

      <div class="filter-pills" style="padding-top:10px;">
        <button class="pill ${state.evidenceFilter === "all" ? "active" : ""}" onclick="App.setEvidenceFilter('all')">Tất cả (${state.evidences.length})</button>
        <button class="pill ${state.evidenceFilter === "pending" ? "active" : ""}" onclick="App.setEvidenceFilter('pending')">Chờ duyệt (${state.evidences.filter((e) => e.status === "pending").length})</button>
        <button class="pill ${state.evidenceFilter === "verified" ? "active" : ""}" onclick="App.setEvidenceFilter('verified')">Đã xác nhận (${state.evidences.filter((e) => e.status === "verified").length})</button>
        <button class="pill ${state.evidenceFilter === "revision" ? "active" : ""}" onclick="App.setEvidenceFilter('revision')">Cần bổ sung (${state.evidences.filter((e) => e.status === "revision").length})</button>
      </div>

      <div class="section-wrap">
        ${filtered
          .map(
            (ev) => `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <strong style="font-size:12.5px;color:var(--primary);">${escHtml(ev.submitterName)}</strong>
              <span class="status-chip ${stMap[ev.status].cls}">${stMap[ev.status].text}</span>
            </div>
            <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${escHtml(ev.activityTitle)}</div>
            <div style="font-size:12.5px;color:#4B5563;line-height:1.4;margin-bottom:6px;">${escHtml(ev.description)}</div>
            ${
              ev.imageDataUrl
                ? `<img src="${ev.imageDataUrl}" class="evidence-thumb" alt="Ảnh minh chứng" onclick="App.openLightbox('${ev.id}')" />`
                : ""
            }
            ${ev.driveUrl ? `<div style="font-size:12px;color:var(--primary);margin-bottom:6px;word-break:break-all;">${icon("link")} ${escHtml(ev.driveUrl)}</div>` : ""}
            ${ev.reviewNote ? `<div style="font-size:12px;background:#F8FAFC;padding:7px 9px;border-radius:8px;color:#334155;margin-bottom:8px;">${icon("edit")} Nhận xét: ${escHtml(ev.reviewNote)}</div>` : ""}
            ${
              canManage() && ev.status === "pending"
                ? `
              <div style="display:flex;gap:8px;margin-top:6px;">
                <button class="btn-success" style="flex:1;" onclick="App.reviewEvidence('${ev.id}','verified')">✓ Xác nhận & Cộng điểm</button>
                <button class="btn-danger" style="flex:1;" onclick="App.reviewEvidence('${ev.id}','revision')">Yêu cầu bổ sung</button>
              </div>
            `
                : ""
            }
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  // 15. LỊCH HOẠT ĐỘNG THÁNG TRỰC QUAN
  function renderCalendar() {
    const year = state.calYear;
    const month = state.calMonth;
    const firstDay = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const startOffset = (firstDay.getDay() + 6) % 7;

    const eventsByDate = {};
    const addEvt = (iso, evt) => {
      if (!iso) return;
      if (!eventsByDate[iso]) eventsByDate[iso] = [];
      eventsByDate[iso].push(evt);
    };

    state.meetings.forEach((m) =>
      addEvt(m.dateIso, { type: "meeting", color: "#005BAC", title: m.title, sub: `${m.time} · ${m.location}`, go: "meetings" })
    );
    state.activities.forEach((a) => {
      addEvt(a.date, { type: "activity", color: "#059669", title: a.title, sub: `${a.category} · ${a.location}`, go: "register" });
      addEvt(a.deadline, { type: "deadline", color: "#D97706", title: `Hạn ĐK: ${a.title}`, sub: `Hạn chót đăng ký tham gia`, go: "register" });
    });

    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push({ empty: true });
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ day: d, iso, evts: eventsByDate[iso] || [] });
    }

    const selectedEvts = eventsByDate[state.calSelectedDate] || [];

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Lịch hoạt động tháng</span>
        </div>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <button class="icon-btn" onclick="App.changeCalMonth(-1)">‹</button>
            <strong style="font-size:15px;">Tháng ${month + 1} / ${year}</strong>
            <button class="icon-btn" onclick="App.changeCalMonth(1)">›</button>
          </div>

          <div class="cal-weekdays">
            <span>T2</span><span>T3</span><span>T4</span><span>T5</span><span>T6</span><span>T7</span><span>CN</span>
          </div>

          <div class="cal-grid">
            ${cells
              .map((c) => {
                if (c.empty) return `<div class="cal-day empty"></div>`;
                const isSel = c.iso === state.calSelectedDate;
                const dots = c.evts
                  .slice(0, 3)
                  .map((e) => `<span class="cal-dot" style="background:${isSel ? "#FFFFFF" : e.color};"></span>`)
                  .join("");
                return `
                  <button class="cal-day ${c.evts.length ? "has-event" : ""} ${isSel ? "selected" : ""}" onclick="App.selectCalDate('${c.iso}')">
                    <span>${c.day}</span>
                    <div class="cal-dots">${dots}</div>
                  </button>
                `;
              })
              .join("")}
          </div>

          <div style="display:flex;gap:12px;justify-content:center;margin-top:12px;font-size:11px;color:var(--text-muted);">
            <span><span class="cal-dot" style="display:inline-block;background:#005BAC;"></span> Sinh hoạt</span>
            <span><span class="cal-dot" style="display:inline-block;background:#059669;"></span> Hoạt động</span>
            <span><span class="cal-dot" style="display:inline-block;background:#D97706;"></span> Hạn ĐK</span>
          </div>
        </div>

        <div class="section-header">
          <h3>Sự kiện ngày ${state.calSelectedDate}</h3>
        </div>
        ${
          selectedEvts.length
            ? selectedEvts
                .map(
                  (e) => `
              <div class="card" style="border-left:4px solid ${e.color};cursor:pointer;" onclick="App.go('${e.go}')">
                <div style="font-size:13.5px;font-weight:700;margin-bottom:3px;">${escHtml(e.title)}</div>
                <div style="font-size:12px;color:var(--text-muted);">${escHtml(e.sub)}</div>
              </div>
            `
                )
                .join("")
            : `<div class="card" style="text-align:center;color:var(--text-muted);font-size:13px;">Không có lịch sự kiện trong ngày này. Chạm vào ngày có chấm màu để xem chi tiết.</div>`
        }
      </div>
    `;
  }

  // 16. THÀNH TÍCH CÁ NHÂN & TẬP THỂ
  function renderAchievements() {
    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Thành tích & Khen thưởng</span>
        </div>
        <button data-manager class="btn-sm" style="background:var(--primary);color:#fff;" onclick="App.openAddAchievementModal()">+ Ghi nhận</button>
      </div>

      <div class="underline-tabs">
        <button class="u-tab ${state.achievementTab === "personal" ? "active" : ""}" onclick="App.setAchievementTab('personal')">
          Cá nhân <span class="tab-count">${state.personalAchievements.length}</span>
        </button>
        <button class="u-tab ${state.achievementTab === "collective" ? "active" : ""}" onclick="App.setAchievementTab('collective')">
          Tập thể <span class="tab-count">${state.collectiveAchievements.length}</span>
        </button>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        ${
          state.achievementTab === "personal"
            ? state.personalAchievements
                .map(
                  (pa) => `
              <div class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <span class="status-chip upcoming">${pa.level}</span>
                  <strong style="color:var(--success);font-size:13px;">+${pa.points} điểm</strong>
                </div>
                <div style="font-size:14px;font-weight:700;margin-bottom:4px;">${icon("award")} ${escHtml(pa.title)}</div>
                <div style="font-size:12.5px;color:#374151;">${icon("user")} <strong>${escHtml(pa.memberName)}</strong> · ${pa.date}</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin-top:3px;">Nhóm: ${pa.category}</div>
              </div>
            `
                )
                .join("")
            : state.collectiveAchievements
                .map((ca) => {
                  const total = ca.participationPoints + ca.achievementPoints;
                  const pPct = Math.round((ca.participationPoints / total) * 100);
                  return `
                <div class="card">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
                    <strong style="font-size:14.5px;color:var(--primary);">${escHtml(ca.unitName)}</strong>
                    <span class="status-chip live">${total} điểm</span>
                  </div>
                  <div style="font-size:13.5px;font-weight:600;margin-bottom:6px;">${icon("award")} ${escHtml(ca.awardTitle)} (${ca.level})</div>
                  <div style="font-size:12px;color:#4B5563;display:flex;justify-content:space-between;">
                    <span>Điểm tham gia: <strong>${ca.participationPoints}</strong></span>
                    <span>Điểm thành tích: <strong>+${ca.achievementPoints}</strong></span>
                  </div>
                  <div style="display:flex;height:9px;border-radius:999px;overflow:hidden;margin-top:6px;background:#E5E7EB;">
                    <div style="width:${pPct}%;background:#005BAC;"></div>
                    <div style="width:${100 - pPct}%;background:#F59E0B;"></div>
                  </div>
                </div>
              `;
                })
                .join("")
        }
      </div>
    `;
  }

  // 17. NHẬP DANH SÁCH ĐOÀN VIÊN TỪ CSV
  function renderImportCsv() {
    const newCount = csvPreviewRows.filter((r) => r.action === "create").length;
    const updCount = csvPreviewRows.filter((r) => r.action === "update").length;

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Nhập danh sách CSV</span>
        </div>
      </div>

      <div class="section-wrap" style="margin-top:12px;">
        <div class="card">
          <div style="font-size:14.5px;font-weight:700;margin-bottom:5px;">Nhập hàng loạt đoàn viên Chi đoàn</div>
          <p style="font-size:12.5px;color:var(--text-muted);line-height:1.45;margin-bottom:12px;">
            Hệ thống tự động đối chiếu theo <strong>Số điện thoại</strong> để phân loại đoàn viên <em>Thêm mới</em> hoặc <em>Cập nhật</em>, tránh trùng lặp.
          </p>
          <button class="btn-outline" style="width:100%;margin-bottom:10px;" onclick="App.downloadSampleCsv()">
            ${icon("download")} Tải file mẫu (.CSV)
          </button>
          <label class="form-label">Chọn file .CSV từ máy tính / điện thoại</label>
          <input type="file" accept=".csv,text/csv" class="form-control" onchange="App.handleCsvFileChange(this)" />
          <details><summary>Dán bảng từ Excel hoặc Google Sheets</summary>
            <label class="form-label">Bảng có dòng tiêu đề<textarea id="csv-paste" class="form-control" rows="5"></textarea></label>
            <button class="btn-outline" onclick="App.previewPaste()">Xem trước danh sách</button></details>

          <p>Trạng thái hợp lệ: Ở địa phương, Đi làm xa, Chuyển sinh hoạt.</p>
        </div>

        ${directoryControls()}
        ${csvPreviewError ? `<div class="card" style="color:#DC2626;font-size:13px;">${icon("warn")} ${escHtml(csvPreviewError)}</div>` : ""}

        ${
          csvPreviewRows.length > 0
            ? `
          <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <strong style="font-size:14px;">Xem trước đối chiếu (${csvPreviewRows.length} dòng)</strong>
              <span style="font-size:12px;color:var(--success);font-weight:700;">+${newCount} mới · ${updCount} cập nhật</span>
            </div>
            <div class="import-preview-wrap">
              <table class="import-preview-table">
                <thead>
                  <tr><th>Họ tên</th><th>SĐT</th>${canMatchMembers() ? "<th>Tài khoản</th>" : ""}<th>Trạng thái</th><th>Thao tác</th></tr>
                </thead>
                <tbody>
                  ${csvPreviewRows.slice(0,100)
                    .map(
                      (r) => `
                    <tr>
                      <td><strong>${escHtml(r.name)}</strong></td>
                      <td>${escHtml(r.phone)}</td>
                      ${canMatchMembers() ? `<td>${registrationBadge(r)}</td>` : ""}
                      <td>${r.status === "local" ? "Địa phương" : r.status === "far" ? "Đi làm xa" : "Chuyển SH"}</td>
                      <td><span class="member-badge ${r.action === "create" ? "badge-local" : "badge-far"}">${r.action === "create" ? "Thêm mới" : "Cập nhật"}</span></td>
                    </tr>
                  `
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
            ${csvPreviewRows.length > 100 ? "<p>Hiển thị 100 dòng đầu.</p>" : ""}
            <button class="btn-primary" style="margin-top:12px;" onclick="App.confirmCsvImport()">
              ✓ Xác nhận nhập ${csvPreviewRows.length} đoàn viên vào Chi đoàn
            </button>
          </div>
        `
            : ""
        }
      </div>
    `;
  }

  // 18. NHẬT KÝ HỆ THỐNG (AUDIT LOGS)
  function renderAudit() {
    const q = state.auditSearch.trim().toLowerCase();
    const filtered = state.auditLogs.filter((l) => {
      const matchType = state.auditFilter === "all" || l.action === state.auditFilter;
      const matchQ =
        !q ||
        l.actor.toLowerCase().includes(q) ||
        l.target.toLowerCase().includes(q) ||
        l.details.toLowerCase().includes(q);
      return matchType && matchQ;
    });

    const actionLabels = {
      create: "Tạo mới",
      approve: "Phê duyệt",
      update: "Cập nhật",
      import: "Nhập CSV",
      checkin: "Điểm danh",
      reject: "Từ chối"
    };

    return `
      <div class="page-header">
        <div class="page-header-left">
          <button class="icon-btn" onclick="App.handleBack()">${icon("back")}</button>
          <span class="page-title">Nhật ký hệ thống (${state.auditLogs.length})</span>
        </div>
      </div>

      <div class="search-bar">
        <div class="search-input-wrap">
          ${icon("search")}
          <input type="text" placeholder="Tìm người thao tác, đối tượng..." value="${escHtml(state.auditSearch)}" data-search="Audit" oninput="if (!event.isComposing) App.setAuditSearch(this.value)" oncompositionend="App.setAuditSearch(this.value)" />
        </div>
      </div>

      <div class="filter-pills">
        ${[
          ["all", "Tất cả"],
          ["create", "Tạo mới"],
          ["approve", "Phê duyệt"],
          ["checkin", "Điểm danh"],
          ["import", "Nhập CSV"],
          ["update", "Cập nhật"]
        ]
          .map(
            ([k, lbl]) => `
          <button class="pill ${state.auditFilter === k ? "active" : ""}" onclick="App.setAuditFilter('${k}')">${lbl}</button>
        `
          )
          .join("")}
      </div>

      <div class="section-wrap">
        ${filtered
          .map(
            (l) => `
          <div class="audit-row">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <span class="audit-badge audit-${l.action}">${actionLabels[l.action] || l.action}</span>
              <span style="font-size:11px;color:var(--text-muted);">${icon("clock")} ${l.time}</span>
            </div>
            <div style="font-size:13.5px;font-weight:700;color:#111827;">${escHtml(l.target)}</div>
            <div style="font-size:12px;color:#4B5563;margin:3px 0;">${escHtml(l.details)}</div>
            <div style="font-size:11px;color:var(--primary);font-weight:600;">${icon("user")} ${escHtml(l.actor)} (${escHtml(l.role)})</div>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  const managerScreens = ["approvals", "import_csv", "audit", "quick_report", "ward"];
  const canManage = () => Boolean(storageKey && ["secretary", "ward_officer"].includes(state.currentRoleId));

  function render() {
    if (state.currentRoleId === "member" && managerScreens.includes(state.currentScreen)) state.currentScreen = "account";
    if (!storageKey || !getCurrentRole()) state.currentScreen = "login";
    renderBottomNav();

    const screen = document.getElementById("app-screen");
    screen.classList.toggle("auth-screen", state.currentScreen === "login");
    const map = {
      login: renderLogin,
      home: renderHome,
      news: renderNews,
      meetings: renderMeetings,
      quick_report: renderQuickReport,
      scan: renderScan,
      members: renderMembers,
      ward: renderWard,
      makeup: renderMakeup,
      points: renderPoints,
      reminders: renderReminders,
      feedback: renderFeedback,
      account: renderAccount,
      register: renderRegister,
      approvals: renderApprovals,
      evidence: renderEvidence,
      calendar: renderCalendar,
      achievements: renderAchievements,
      import_csv: renderImportCsv,
      audit: renderAudit
    };

    const active = document.activeElement;
    const search = active?.dataset.search;
    const caret = search ? active.selectionStart : null;
    const scroll = screen.scrollTop;
    screen.innerHTML = (firebaseSession ? DoanManagement.scope() : "") + (work.error && firebaseSession ? `<p role="status" class="card">${escHtml(work.error)} <button class="btn-outline" onclick="App.retryUnitSync()">Tải lại dữ liệu đơn vị</button></p>` : "") + (map[state.currentScreen] || renderHome)();
    if (state.currentRoleId === "member") {
      screen.querySelectorAll("[data-manager]").forEach(el => el.remove());
      for (const route of managerScreens) {
        screen.querySelectorAll(`[onclick="App.go('${route}')"]`).forEach(el => el.remove());
      }
      const title = [...screen.querySelectorAll(".menu-list-title")].find(el => el.textContent === "Quản trị & Tiện ích");
      if (title) title.textContent = "Tiện ích";
    }
    const replacement = search && screen.querySelector('input[data-search="' + search + '"]');
    if (replacement) {
      replacement.focus({ preventScroll: true });
      replacement.setSelectionRange(caret, caret);
    }
    screen.scrollTop = replacement ? scroll : 0;
  }


  function renderPendingDocsPreview() {
    const el = document.getElementById("pending-docs-list");
    if (!el) return;
    if (!pendingMeetingDocs.length) {
      el.innerHTML = `<div style="font-size:12px;color:var(--text-muted);">Chưa có tài liệu nào được chọn.</div>`;
      return;
    }
    el.innerHTML = pendingMeetingDocs
      .map(
        (d, idx) => `
      <div style="display:flex;justify-content:space-between;align-items:center;background:#F8FAFC;border:1px solid #E2E8F0;border-radius:9px;padding:6px 10px;margin-bottom:5px;font-size:12px;">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${icon("file")} <strong>${escHtml(d.name)}</strong> (${escHtml(d.size)})</span>
        <button type="button" style="border:none;background:none;color:#DC2626;font-weight:700;cursor:pointer;margin-left:8px;" onclick="App.removePendingDoc(${idx})">✕</button>
      </div>
    `
      )
      .join("");
  }

  function firebaseStatus(pending, message = "") {
    firebaseLoginPending = pending;
    const screen = document.getElementById("app-screen");
    screen.querySelectorAll("button, input, select").forEach(field => field.disabled = pending);
    const submit = screen.querySelector("[data-auth-submit]");
    if (submit) submit.innerHTML = pending ? escHtml(message) : escHtml(submit.dataset.authSubmit) + icon("arrow-right");

    const status = document.getElementById("auth-status");
    if (status) {
      status.textContent = message;
      status.hidden = !message;
    }
  }

  // Public API
  window.App = {
    onUnitSnapshot: work.snapshot,
    onManagementResult: DoanManagement.complete,
    onUnitWrite: work.complete,
    handleBack() {
      if (document.getElementById("modal-root").firstElementChild) {
        closeModal();
        return true;
      }
      if (state.currentScreen === "login" && registrationPage !== "login") {
        if (!firebaseLoginPending) App.accountSettings();
        return true;
      }
      const previous = routes.pop();
      if (previous) {
        App.showScreen(previous.screen);
        document.getElementById("app-screen").scrollTop = previous.scroll;
        return true;
      }
      if (state.currentScreen === "home" || state.currentScreen === "login") return false;
      App.openTab("home");
      return true;
    },
    openTab(screen) {
      routes.length = 0;
      selectedTab = screen;
      App.showScreen(screen);
    },
    go(screen) {
      if (screen !== state.currentScreen && state.currentScreen !== "login") {
        routes.push({screen:state.currentScreen,scroll:document.getElementById("app-screen").scrollTop});
      }
      App.showScreen(screen);
    },
    showScreen(screen) {
      closeModal();
      state.currentScreen = screen;
      saveState();
      render();
      if (canMatchMembers() && ["members", "import_csv"].includes(screen)) App.refreshRegistrations();
    },
    refreshRegistrations() {
      if (!canMatchMembers()) return;
      directoryByPhone = null;
      directoryMessage = "Đang đối chiếu với hồ sơ chi đoàn…";
      updateRegistrationLabels();
      window.AndroidBridge.firebaseMemberDirectory(firebaseSession.uid, firebaseSession.unitCode, ++directoryRequest);
    },
    onMemberDirectory(result) {
      if (!canMatchMembers() || result.uid !== firebaseSession.uid || result.requestId !== directoryRequest) return;
      if (result.error) {
        directoryByPhone = null;
        directoryMessage = result.error;
      } else {
        directoryByPhone = new Map();
        let missing = 0;
        for (const member of result.members) {
          const phone = DoanFeatures.phoneKey(member.phone);
          if (!/^0\d{9,10}$/.test(phone)) { missing++; continue; }
          const names = directoryByPhone.get(phone) || [];
          names.push(member.name);
          directoryByPhone.set(phone, names);
        }
        directoryMessage = "Đã đối chiếu với hồ sơ đoàn viên trong chi đoàn." +
          (missing ? " Có " + missing + " tài khoản chưa có SĐT hợp lệ." : "");
      }
      updateRegistrationLabels();
    },
    saveMemberPhone(form) {
      if (!firebaseSession || state.currentRoleId !== "member" || savingPhone) return;
      const phone = DoanFeatures.phoneKey(form.elements.phone.value);
      if (!/^0\d{9,10}$/.test(phone)) return showToast("Số điện thoại chưa hợp lệ", "Kiểm tra số điện thoại bắt đầu bằng 0 hoặc +84.");
      savingPhone = true;
      form.querySelector("button").disabled = true;
      window.AndroidBridge.firebaseSaveMemberPhone(firebaseSession.uid, phone, ++phoneRequest);
    },
    onMemberPhoneSaved(result) {
      if (result.uid !== firebaseSession?.uid || result.requestId !== phoneRequest) return;
      savingPhone = false;
      if (result.error) {
        const button = document.querySelector("form [name=phone]")?.form?.querySelector("button");
        if (button) button.disabled = false;
        return showToast("Chưa xác nhận lưu SĐT", result.error);
      }
      getCurrentRole().phone = result.phone;
      saveState();
      if (state.currentScreen === "account") render();
      showToast("Đã lưu số điện thoại", "Bí thư có thể đối chiếu khi tải lại danh sách.");
    },
    onArticleLink(link) {
      if (!link || typeof link.unit !== "string" || !/^[\w-]{1,100}$/.test(link.id)) return;
      sessionStorage.setItem("pendingArticle",JSON.stringify(link));
      openPendingArticle();
    },
    retryUnitSync() {
      if (!firebaseSession) return;
      work.start(firebaseSession, canManage(), refreshUnitWork);
      if (firebaseSession.officer) DoanManagement.restoreUnit();
    },
    onFirebaseProfileLoading() {
      if (firebaseLoginPending) firebaseStatus(true, "Đang tải hồ sơ chi đoàn từ Firestore…");
    },
    loginWithGoogle() {
      if (firebaseLoginPending || storageKey) return;
      firebaseStatus(true, "Đang đăng nhập bằng Google…");
      window.AndroidBridge.firebaseSetRememberLogin?.(document.querySelector('input[name="remember"]')?.checked !== false);
      window.AndroidBridge.googleSignIn();
    },
    togglePassword(button) {
      const input = document.getElementById("auth-password");
      if (!input || firebaseLoginPending) return;
      const visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.setAttribute("aria-label", visible ? "Ẩn mật khẩu" : "Hiện mật khẩu");
      button.innerHTML = icon(visible ? "eye" : "eye-off");
    },
    showPasswordReset() {
      if (storageKey || firebaseLoginPending) return;
      const email = document.querySelector('input[name="email"]')?.value || "";
      registrationPage = "reset";
      render();
      document.querySelector('input[name="email"]').value = email;
    },
    resetPassword(form) {
      if (firebaseLoginPending || storageKey || registrationPage !== "reset") return;
      const field = form.elements.email, email = field.value.trim();
      if (!email || field.validity.typeMismatch) {
        field.focus();
        return firebaseStatus(false, "Nhập địa chỉ email hợp lệ.");
      }
      if (!window.AndroidBridge?.firebaseResetPassword)
        return firebaseStatus(false, "Cập nhật ứng dụng để sử dụng chức năng này.");
      firebaseStatus(true, "Đang gửi yêu cầu…");
      try { window.AndroidBridge.firebaseResetPassword(email); }
      catch { firebaseStatus(false, "Chưa gửi được yêu cầu. Vui lòng thử lại."); }
    },
    onPasswordReset(result) {
      if (registrationPage !== "reset" || !firebaseLoginPending || storageKey) return;
      firebaseStatus(false, result.error || "Nếu email này có tài khoản, bạn sẽ nhận được liên kết đặt lại mật khẩu. Kiểm tra cả thư rác.");
    },
    showRegistration(show) {
      if (storageKey || firebaseLoginPending) return;
      const email = document.querySelector('input[name="email"]')?.value || "";
      registrationPage = show ? "register" : "login";
      render();
      const input = document.querySelector('input[name="email"]');
      if (input) input.value = email;
    },
    loginWithEmail(form) {
      if (firebaseLoginPending || storageKey) return;
      const emailField = form.elements.email;
      const passwordField = form.elements.password;
      const email = emailField.value.trim();
      const password = passwordField.value;
      const registering = registrationPage === "register";
      if (!email || emailField.validity.typeMismatch) {
        emailField.focus();
        return firebaseStatus(false, "Nhập địa chỉ email hợp lệ.");
      }
      if (!password || (registering && password.length < 6)) {
        passwordField.focus();
        return firebaseStatus(false, registering ? "Nhập mật khẩu có ít nhất 6 ký tự." : "Nhập mật khẩu để đăng nhập.");
      }
      document.activeElement?.blur();
      firebaseStatus(true, registering ? "Đang tạo tài khoản…" : "Đang đăng nhập…");
      try {
        window.AndroidBridge.firebaseSetRememberLogin?.(registering || form.elements.remember?.checked !== false);
        if (registering) window.AndroidBridge.firebaseRegister(email, password);
        else window.AndroidBridge.firebaseSignIn(email, password);
      } catch {
        firebaseStatus(false, "Chưa gửi được yêu cầu. Hãy đóng và mở lại ứng dụng rồi thử lại.");
      }
    },
    changeRegistrationRole(form) {
      const box = document.getElementById("registration-unit");
      const role = form.elements.role.value;
      const phoneField = form.elements.phone;
      phoneField.disabled = role !== "doan_vien";
      phoneField.required = !phoneField.disabled;
      phoneField.closest("label").hidden = phoneField.disabled;
      if (role === "bi_thu") {
        box.innerHTML = '<label class="form-label">Tên chi đoàn mới<input class="form-control" name="unit" maxlength="120" required></label>';
      } else if (role === "doan_vien") {
        box.innerHTML = '<label class="form-label">Chi đoàn<select class="form-control" name="unit" required><option value="">Đang tải danh sách…</option></select></label><p id="unit-status" role="status"></p><button type="button" class="btn-outline" onclick="App.changeRegistrationRole(this.form)">Tải lại danh sách</button>';
        window.AndroidBridge.firebaseListUnits(registrationUid);
      } else {
        box.replaceChildren();
      }
    },
    onFirebaseUnits(result) {
      const form = document.getElementById("registration-profile");
      if (!form || result.uid !== registrationUid || form.elements.role.value !== "doan_vien") return;
      const select = form.elements.unit;
      const units = result.units || [];
      const hint = result.error || (units.length ? "Chọn chi đoàn" : "Chưa có chi đoàn nào được đăng ký");
      select.replaceChildren(new Option(hint, ""));
      for (const unit of units) select.add(new Option(unit.name + " · " + unit.id.slice(-6), unit.id));
      document.getElementById("unit-status").textContent = result.error ||
        (units.length ? "" : "Danh sách còn trống. Bí thư cần hoàn tất đăng ký chi đoàn trước.");
    },
    completeRegistration(form) {
      if (!registrationUid || firebaseLoginPending || registrationPage !== "profile") return;
      const role = form.elements.role.value;
      const name = form.elements.fullName.value.trim();
      const unit = form.elements.unit?.value.trim();
      if (!name || !unit || !["bi_thu", "doan_vien"].includes(role)) {
        return showToast("Thiếu thông tin", "Điền họ tên và chọn hoặc đặt tên chi đoàn.");
      }
      const phone = role === "doan_vien" ? DoanFeatures.phoneKey(form.elements.phone.value) : "";
      if (role === "doan_vien" && !/^0\d{9,10}$/.test(phone)) {
        return firebaseStatus(false, "Nhập số điện thoại hợp lệ để Bí thư đối chiếu danh sách.");
      }
      firebaseStatus(true, "Đang lưu hồ sơ chi đoàn…");
      window.AndroidBridge.firebaseCompleteProfile(role, name, unit, phone);
    },
    retryFirebaseProfile() {
      if (!["retry", "profile"].includes(registrationPage) || firebaseLoginPending) return;
      firebaseStatus(true, "Đang tải lại hồ sơ…");
      window.AndroidBridge.firebaseRetryProfile();
    },


    accountSettings() {
      DoanManagement.reset();
      feedbackDraft = null;
      feedbackBusy = false;
      entryBusy = false;
      work.reset();
      firebaseSession = null;
      directoryByPhone = null;
      directoryMessage = "";
      directoryRequest++;
      phoneRequest++;
      savingPhone = false;
      firebaseLoginPending = false;
      registrationPage = "login";
      registrationUid = "";
      profileError = "";
      window.AndroidBridge?.firebaseSignOut?.();

      storageKey = null;

      csvPreviewRows = [];
      csvPreviewError = "";
      inputRevision++;
      pendingMeetingDocs = [];
      pendingEvidenceImage = "";
      state = loadState();
      closeModal();
      render();
    },


    openEntryForm(kind) {
      if (state.currentRoleId === "member") return;
      const titles = { news: "Viết tin", makeup: "Tạo buổi sinh hoạt bù", register: "Mở đăng ký hoạt động", points: "Tạo hoạt động tình nguyện" };
      if (!titles[kind]) return;
      if (entryBusy) return;
      closeModal();
      if (kind === "news") newsDraft = work.newId();
      const input = (label, name, type = "text", attrs = "") =>
        `<label class="form-label">${label}<input class="form-control" name="${name}" type="${type}" ${attrs} required></label>`;
      const options = (label, name, values) => `<label class="form-label">${label}<select class="form-control" name="${name}">${values.map(v => `<option>${escHtml(v)}</option>`).join("")}</select></label>`;
      openModal(`<form onsubmit="event.preventDefault();App.saveEntry('${kind}',this)">
        <h3>${titles[kind]}</h3>${input("Tiêu đề", "title", "text", 'maxlength="180"')}
        ${kind === "news" ? options("Chuyên mục", "category", state.newsCategories.slice(1)) :
          input("Ngày diễn ra", "date", "date") + input("Địa điểm", "location")}
        ${kind === "register" ? options("Nhóm hoạt động", "category", state.activityCategories.map(c => c.name)) + input("Hạn đăng ký", "deadline", "date") : ""}
        ${["register","points"].includes(kind) ? input("Điểm thi đua", "points", "number", 'min="0" max="1000"') : ""}
        ${kind === "makeup" ? input("Số chỗ", "slots", "number", 'min="1" max="10000"') + input("Giờ bắt đầu", "time", "time") + input("Giờ kết thúc", "endTime", "time") : ""}
        ${["register","news"].includes(kind) ? '<label class="form-label">Nội dung<textarea class="form-control" name="description" required></textarea></label>' : ""}
        ${kind === "news" && newsAttachmentsEnabled ? `<div class="form-group"><label class="form-label">Tệp, hình ảnh và video đính kèm</label>
          <p>Tối đa 5 tệp. Ảnh, PDF, Word, Excel, TXT tối đa 20 MB/tệp. Video MP4/WebM tối đa 50 MB/tệp.</p>
          <button type="button" class="btn-outline" id="news-pick" onclick="App.pickNewsFiles()">+ Chọn tệp / ảnh / video</button>
          <div id="news-files" aria-live="polite"></div></div>` : ""}
        <p id="entry-status" role="status"></p>
        <button class="btn-primary">${kind === "news" ? "Đăng bài viết" : "Lưu hoạt động"}</button><button type="button" class="btn-outline" onclick="App.closeModal()">Hủy</button></form>`);
    },
    async saveEntry(kind, form) {
      if (entryBusy || state.currentRoleId === "member" || !form.reportValidity()) return;
      const f = Object.fromEntries(new FormData(form));
      for (const key of Object.keys(f)) {
        f[key] = f[key].trim();
        if (!f[key]) return showToast("Thiếu thông tin", "Vui lòng điền đủ các trường.");
      }
      const id = form.dataset.entryId ||= (kind === "news" ? newsDraft : work.newId());
      if (kind === "news") {
        if (newsPicking) return showToast("Đang đọc tệp","Vui lòng chờ đọc xong tệp.");
        entryBusy = true;
        const fields = [...form.elements];
        fields.forEach(field=>field.disabled=true);
        const status = document.getElementById("entry-status");
        try {
          status.textContent = newsFiles.length ? "Đang tải tệp đính kèm…" : "Đang đăng bài…";
          const attachments = newsAttachmentsEnabled && newsFiles.length ? (await DoanManagement.request("upload",{},(session,requestId)=>
            window.NewsAttachments.upload(session.uid,session.unitCode,id,requestId))).attachments : [];
          const createdAt = Number(form.dataset.createdAt ||= String(Date.now()));
          const content = {title:f.title, category:f.category, content:f.description, summary:f.description.slice(0,180),
            tag:f.category, date:new Date(createdAt).toLocaleDateString("vi-VN"), createdAt,attachments};
          status.textContent = "Đang lưu bài viết…";
          if (!await sendWork("publish",{id,kind,content})) return;
          state.newsCategory = "Trang chủ";
        } catch (e) { showToast("Chưa đăng bài",e.message); return; }
        finally {
          entryBusy = false;
          fields.forEach(field=>field.disabled=false);
          status.textContent = "";
        }
      } else if (kind === "register") {
        if (f.deadline > f.date || f.deadline < localDate()) return showToast("Hạn đăng ký không hợp lệ", "Chọn từ hôm nay đến ngày diễn ra.");
        if (!await sendWork("publish",{id,kind,deadline:new Date(f.deadline+"T23:59:59.999").getTime(),points:Number(f.points),content:{...f,createdAt:Date.now(),status:"Đang mở đăng ký"}})) return;
        state.registerTab = "open";
        state.registerCatFilter = "all";
      } else if (kind === "makeup") {
        if (f.time === f.endTime) return showToast("Kiểm tra giờ buổi bù","Giờ bắt đầu và kết thúc phải khác nhau.");
        if (!await sendWork("publish",{id,kind,capacity:Number(f.slots),content:{title:f.title,location:f.location,time:f.date+" "+f.time,endTime:f.endTime,createdAt:Date.now()}})) return;
      } else if (kind === "points") {
        if (!await sendWork("publish",{id,kind,points:Number(f.points),content:{title:f.title,location:f.location,time:f.date,createdAt:Date.now()}})) return;
      } else return;
      logAudit("create", f.title, "Tạo nội dung hoạt động.");
      saveState();
      closeModal(kind === "news");
      render();
    },
    onNewsUploadProgress(result) {
      if (result.uid !== firebaseSession?.uid || result.draft !== newsDraft) return;
      const status = document.getElementById("entry-status");
      if (status) status.textContent = "Đang tải tệp " + result.index + "/" + newsFiles.length + " · " + result.percent + "%";
    },
    pickNewsFiles() {
      if (!newsAttachmentsEnabled || !newsDraft || newsPicking || entryBusy || !firebaseSession) return;
      newsPicking = true;
      document.getElementById("news-pick").disabled = true;
      window.NewsAttachments.select(firebaseSession.uid,newsDraft);
    },
    onNewsSelection(result) {
      if (result.uid !== firebaseSession?.uid || result.draft !== newsDraft) return;
      newsPicking = false;
      newsFiles = result.files || [];
      const button = document.getElementById("news-pick");
      if (button) button.disabled = false;
      const list = document.getElementById("news-files");
      if (list) list.innerHTML = newsFiles.map(file=>`<p>${escHtml(file.name)} · ${(file.size/1024/1024).toFixed(1)} MB
        <button type="button" class="btn-outline" onclick="App.removeNewsFile('${file.id}')">Bỏ tệp</button></p>`).join("");
      if (result.error) showToast("Chọn tệp đính kèm",result.error);
    },
    removeNewsFile(id) {
      if (newsAttachmentsEnabled && !entryBusy && !newsPicking && newsDraft) window.NewsAttachments.remove(firebaseSession.uid,newsDraft,id);
    },
    selectScanMember(id) {
      state.scanMemberId = id;
      saveState();
      render();
    },
    goMembersFilter(filter) {
      state.memberFilter = filter;
      App.go("members");
    },
    setMeetingTab(tab) {
      state.meetingTab = tab;
      render();
    },
    setMeetingSearch(val) {
      state.meetingSearch = val;
      render();
    },
    setMemberFilter(f) {
      state.memberFilter = f;
      render();
    },
    setMemberSearch(val) {
      state.memberSearch = val;
      render();
    },
    setWardMonth(val) {
      if (!/^\d{4}-\d{2}$/.test(val)) return;
      state.wardMonth = val;
      saveState();
      render();
    },
    setWorkerShift(shift) {
      state.workerShift = shift;
      saveState();
      render();
    },

    // ====== BẢNG TIN RIÊNG BIỆT ======
    setNewsCategory(cat) {
      state.newsCategory = cat;
      render();
    },
    toggleNewsSearch() {
      state.newsSearchOpen = !state.newsSearchOpen;
      if (!state.newsSearchOpen) state.newsSearch = "";
      render();
    },
    setNewsSearch(val) {
      state.newsSearch = val;
      render();
    },
    toggleNewsLike(id) {
      const item = state.news.find((n) => n.id === id);
      if (!item) return;
      if (item.cloud) {
        state.likedArticles ||= {};
        state.likedArticles[id] = !item.liked;
      }
      item.liked = !item.liked;
      item.likes += item.liked ? 1 : -1;
      saveState();
      render();
    },
    async shareNews(id) {
      const item = state.news.find((n) => n.id === id);
      if (!item) return;
      try {
        if (!item.cloud) {
          if (!canManage()) return showToast("Bài viết chỉ có trên máy","Cần người đăng chia sẻ bài viết lên bảng tin của đơn vị.");
          if (!await sendWork("publishLegacy",{id,kind:"news",content:{title:item.title,summary:item.summary,content:item.content || item.summary,
            tag:item.category,category:item.category,date:item.date,createdAt:Date.now()}})) return;
        }
        const link = "doanvienso://news/"+encodeURIComponent(firebaseSession.unitCode)+"/"+encodeURIComponent(id);
        if (window.AndroidBridge?.copyArticleLink) AndroidBridge.copyArticleLink(link);
        else await navigator.clipboard.writeText(link);
        showToast("Đã sao chép liên kết","Gửi liên kết cho người cùng đơn vị để mở bài trong ứng dụng.");
      } catch {
        showToast("Chưa sao chép được", "Thiết bị chưa cho phép truy cập bộ nhớ tạm.");
      }
    },
    openArticleChat(id, index) {
      const article = index === undefined ? state.news.find(item => item.id === id) :
        state.meetings.find(item => item.id === id)?.documents?.[index];
      if (!article) return;
      const title = article.title || article.name;
      const source = [title, article.date, article.content || article.summary].filter(Boolean).join("\n");
      openModal(`<h3>Hỏi AI</h3><p>${escHtml(title)}</p>
        <form id="article-chat"><label class="form-label">Câu hỏi
        <textarea class="form-control" name="question" required>Tóm tắt các ý chính.</textarea></label>
        <p>Nội dung hiển thị và câu hỏi sẽ được gửi đến ChatGPT.</p>
        <button class="btn-primary">Mở ChatGPT</button>
        <button type="button" class="btn-outline" onclick="App.closeModal()">Đóng</button></form>`);
      document.getElementById("article-chat").onsubmit = event => {
        event.preventDefault();
        const question = event.target.elements.question.value.trim();
        if (!question) return;
        const prompt = question + "\n\nDựa trên nội dung sau:\n" + source;
        if (window.AndroidBridge) AndroidBridge.openArticleChat(prompt);
        else window.open("https://chatgpt.com/?q=" + encodeURIComponent(prompt), "_blank", "noopener");
      };
    },
    openNewsDetailModal(id) {
      const item = state.news.find((n) => n.id === id);
      if (!item) return;
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span class="cat-badge" style="background:var(--primary-light);color:var(--primary);">${escHtml(item.category)}</span>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div class="news-cover" style="background:${item.bannerGradient};border-radius:14px;height:110px;margin-bottom:12px;">
          <span class="news-cover-tag">${escHtml(item.bannerLabel || item.tag)}</span>
          <div class="news-cover-headline">${escHtml(item.title)}</div>
        </div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${icon("clock")} ${escHtml(item.date)} · ${icon("heart")} ${item.likes} lượt thích</div>
        <div style="font-size:13.5px;color:#1F2937;line-height:1.6;margin-bottom:14px;">${escHtml(item.content || item.summary)}</div>
        ${renderNewsAttachments(item.attachments)}
        <button class="news-action-btn article-chat-btn" onclick="App.openArticleChat('${item.id}')">${icon("msg")} Hỏi AI</button>
        <button class="btn-primary" onclick="App.closeModal()">Đóng bài viết</button>
      `);
    },

    // ====== TẠO BUỔI SINH HOẠT KÈM TÀI LIỆU ĐÍNH KÈM ======
    openCreateMeetingModal() {
      if (!canManage()) return;
      pendingMeetingDocs = [];
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16.5px;font-weight:800;">Tạo buổi sinh hoạt & Đính kèm tài liệu</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div class="form-group">
          <label class="form-label">Tiêu đề buổi sinh hoạt <span class="req">*</span></label>
          <input id="new-m-title" class="form-control" maxlength="180" placeholder="Nhập tiêu đề" />
        </div>
        <div class="form-group">
          <label class="form-label">Loại sinh hoạt</label>
          <select id="new-m-type" class="form-control">
            <option value="Thường kỳ">Thường kỳ</option>
            <option value="Chuyên đề">Chuyên đề</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Địa điểm <span class="req">*</span></label>
          <input id="new-m-loc" class="form-control" maxlength="240" placeholder="Nhập địa điểm" />
        </div>
        <div class="form-group">
          <label class="form-label">Ngày sinh hoạt<input type="date" id="new-m-date" class="form-control" value="${localDate()}" required></label>
          <label class="form-label">Giờ bắt đầu<input type="time" id="new-m-time" class="form-control" required></label>
          <label class="form-label">Hạn điểm danh<input type="datetime-local" id="new-m-deadline" class="form-control" required></label>
        </div>
        <div class="form-group">
          <label class="form-label">Tài liệu sinh hoạt đính kèm (PDF, DOCX, PPTX...)</label>
          <input type="file" multiple accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.png,.jpg" class="form-control" onchange="App.handleMeetingDocFiles(this)" />
          <div style="display:flex;gap:6px;margin-top:6px;">
            <input id="new-doc-name" class="form-control" style="padding:7px 10px;font-size:12.5px;" placeholder="Hoặc nhập tên tài liệu nhanh..." />
            <button type="button" class="btn-sm" style="background:var(--primary-light);color:var(--primary);white-space:nowrap;" onclick="App.addManualMeetingDoc()">+ Thêm</button>
          </div>
          <div id="pending-docs-list" style="margin-top:8px;"></div>
        </div>
        <button id="save-meeting" class="btn-primary" onclick="App.createMeeting()">Tạo buổi & Sinh mã QR ngay</button>
      `);
      renderPendingDocsPreview();
    },
    handleMeetingDocFiles(input) {
      const files = Array.from(input.files || []);
      if (files.some((f) => f.size > 5 * 1024 * 1024)) {
        input.value = "";
        showToast("Tệp quá lớn", "Mỗi tài liệu tối đa 5 MB. Vui lòng chọn lại.");
        return;
      }
      files.forEach((f) => {
        const sizeKb = f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(f.size / 1024)) + " KB";
        pendingMeetingDocs.push({
          name: f.name,
          size: sizeKb,
          file: f,
          summary: "Tài liệu sinh hoạt được Bí thư tải lên trực tiếp từ thiết bị."
        });
      });
      renderPendingDocsPreview();
    },
    addManualMeetingDoc() {
      const inp = document.getElementById("new-doc-name");
      const name = (inp && inp.value.trim()) || "";
      if (!name) return;
      pendingMeetingDocs.push({
        name,
        size: "Chỉ có mô tả",
        summary: "Tài liệu tham khảo đính kèm cho đoàn viên đọc trước buổi sinh hoạt."
      });
      inp.value = "";
      renderPendingDocsPreview();
    },
    removePendingDoc(idx) {
      pendingMeetingDocs.splice(idx, 1);
      renderPendingDocsPreview();
    },
    async createMeeting() {
      if (!canManage()) return;
      const title = document.getElementById("new-m-title").value.trim();
      const type = document.getElementById("new-m-type").value;
      const location = document.getElementById("new-m-loc").value.trim();
      const dateIso = document.getElementById("new-m-date").value;
      const clock = document.getElementById("new-m-time").value;
      const start = new Date(dateIso+"T"+clock).getTime();
      const deadline = new Date(document.getElementById("new-m-deadline").value).getTime();
      if (!title || !location || !Number.isFinite(start) || !Number.isFinite(deadline) || deadline <= Math.max(start,Date.now())) {
        return showToast("Kiểm tra thông tin buổi sinh hoạt","Nhập tên, địa điểm, ngày, giờ và hạn điểm danh sau giờ bắt đầu.");
      }
      let audience;
      try { audience = work.audience(state); } catch (e) { return showToast("Chưa tải được danh sách", e.message); }
      const time = dateIso.split("-").reverse().join("/")+" "+clock;
      const formButton = document.getElementById("save-meeting");
      const meetingId = formButton.dataset.meetingId ||= work.newId();
      const code = formButton.dataset.secret ||= work.newId().slice(0,12).toUpperCase();
      const button = document.getElementById("save-meeting");
      if (button.disabled) return;
      button.disabled = true;
      const selectedDocs = pendingMeetingDocs.slice();
      const docs = selectedDocs.map(({file, ...metadata}, index) =>
        file ? { ...metadata, fileKey: meetingId + "-" + index } : metadata
      );
      if (selectedDocs.some((d) => d.file)) {
        try {
          await withAttachments("readwrite", (files) => selectedDocs.forEach((d, i) => {
            if (d.file) files.put(d.file, docs[i].fileKey);
          }));
        } catch {
          button.disabled = false;
          showToast("Chưa lưu được tài liệu", "Hãy kiểm tra dung lượng thiết bị và thử lại.");
          return;
        }
      }
      const details = {title,type,location,time,dateIso,unit:getCurrentRole().unit,createdAt:Date.now(),audience,
        documents:docs.map(({fileKey,...metadata})=>metadata)};
      if (!await sendWork("publish",{id:meetingId,kind:"meeting",content:details,deadline,points:10,code})) {
        button.disabled = false;
        return;
      }
      state.localMeetingFiles ||= {};
      state.localMeetingFiles[meetingId] = docs;
      logAudit("create",title,"Đã mở điểm danh cho đơn vị.");
      saveState();
      pendingMeetingDocs = [];
      closeModal();
      pendingQr = meetingId;
      refreshUnitWork();
      showToast("Đã tạo buổi sinh hoạt",time);

    },
    async downloadMeetingDoc(meetingId, index) {
      const doc = state.meetings.find((m) => m.id === meetingId)?.documents?.[index];
      if (!doc?.fileKey) return;
      try {
        const file = await withAttachments("readonly", (files) => files.get(doc.fileKey));
        if (!file) throw new Error("missing");
        DoanFeatures.downloadBlob(file, doc.name);
      } catch {
        showToast("Không thể mở tệp", "Bản đính kèm không còn trong bộ nhớ của thiết bị.");
      }
    },
    openMeetingDocsModal(meetingId) {
      const m = state.meetings.find((x) => x.id === meetingId);
      if (!m) return;
      const docs = m.documents || [];
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Tài liệu sinh hoạt (${docs.length})</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div style="font-size:13px;font-weight:700;color:var(--primary);margin-bottom:10px;">${escHtml(m.title)}</div>
        ${
          docs.length
            ? docs
                .map(
                  (d, index) => `
              <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;padding:11px;margin-bottom:9px;">
                <div style="font-size:13.5px;font-weight:700;color:#0F172A;word-break:break-all;">${icon("file")} ${escHtml(d.name)}</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin:2px 0 5px;">Dung lượng: ${escHtml(d.size)}</div>
                <div style="font-size:12.5px;color:#334155;line-height:1.45;margin-bottom:8px;">${escHtml(d.summary || "Tài liệu phục vụ buổi sinh hoạt chi đoàn.")}</div>
                <button class="news-action-btn article-chat-btn" onclick="App.openArticleChat('${m.id}', ${index})">${icon("msg")} Hỏi AI</button>
                ${d.fileKey
                  ? `<button class="btn-outline" onclick="App.downloadMeetingDoc('${m.id}', ${index})">Lưu bản đính kèm</button>`
                  : '<div style="font-size:12px;color:var(--text-muted);">Chỉ có mô tả, chưa đính kèm tệp.</div>'}
              </div>
            `
                )
                .join("")
            : `<div style="font-size:13px;color:var(--text-muted);">Chưa có tài liệu đính kèm.</div>`
        }
        <button class="btn-primary" style="margin-top:6px;" onclick="App.closeModal()">Đóng</button>
      `);
    },

    // ====== BÁO CÁO NHANH CHO BÍ THƯ ======
    setQuickReportTab(tab) {
      state.quickReportTab = tab;
      render();
    },
    startQuickReportFromMeeting(meetingId) {
      if (!canManage()) return;
      state.quickReportTab = "create";
      App.go("quick_report");
      setTimeout(() => {
        const sel = document.getElementById("qrpt-meeting-select");
        if (sel) sel.value = meetingId;
        App.prefillQuickReport(meetingId);
      }, 20);
    },
    prefillQuickReport(meetingId) {
      const m = state.meetings.find((x) => x.id === meetingId);
      if (!m) return;
      const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el) el.value = v;
      };
      setVal("qrpt-title", `Báo cáo nhanh ${m.title}`);
      setVal("qrpt-time", m.time);
      setVal("qrpt-location", m.location);
      setVal(
        "qrpt-attendees",
        `${m.attendees}/${m.totalTarget} đoàn viên · ${m.unit}`
      );
      showToast("Đã tự động điền", "Thông tin thời gian, địa điểm và quân số QR đã được điền sẵn.");
    },
    saveQuickReport(printAfter = false) {
      if (!canManage()) return;
      const getVal = (id) => ((document.getElementById(id) && document.getElementById(id).value) || "").trim();
      const title = getVal("qrpt-title") || "Báo cáo nhanh sinh hoạt Chi đoàn";
      const time = getVal("qrpt-time");
      const location = getVal("qrpt-location");
      const attendees = getVal("qrpt-attendees");
      const agenda = getVal("qrpt-agenda");
      const discussion = getVal("qrpt-discussion");
      const conclusion = getVal("qrpt-conclusion");

      if (!time || !location || !attendees || !agenda || !discussion || !conclusion) {
        showToast("Thiếu thông tin", "Vui lòng điền đầy đủ 6 mục theo mẫu báo cáo nhanh.");
        return;
      }

      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const createdAt = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

      const report = {
        id: "QRPT-" + Date.now(),
        title,
        time,
        location,
        attendees,
        agenda,
        discussion,
        conclusion,
        unit: getCurrentRole().unit,
        createdBy: getCurrentRole().userName,
        createdAt
      };

      state.quickReports.unshift(report);
      logAudit("create", title, `Bí thư lập báo cáo nhanh sinh hoạt Chi đoàn (${time}).`);
      state.quickReportTab = "list";
      saveState();
      render();

      if (printAfter) {
        DoanFeatures.printQuickReport(report, report.createdBy);
        showToast("Đã lưu & mở bản in PDF", "Bạn có thể chọn 'Save as PDF' để gửi Đoàn Phường.");
      } else {
        showToast("Đã lưu báo cáo nhanh", "Báo cáo đã được lưu vào danh sách và sẵn sàng gửi Zalo/PDF.");
      }
    },
    printSavedQuickReport(id) {
      const r = state.quickReports.find((x) => x.id === id);
      if (!r) return;
      DoanFeatures.printQuickReport(r, r.createdBy || getCurrentRole().userName);
      showToast("Đang mở cửa sổ In / Lưu PDF", r.title);
    },
    copyQuickReportText(id) {
      const r = state.quickReports.find((x) => x.id === id);
      if (!r) return;
      const text = [
        `BÁO CÁO NHANH SINH HOẠT CHI ĐOÀN`,
        `${r.title}`,
        `1. Thời gian: ${r.time}`,
        `2. Địa điểm: ${r.location}`,
        `3. Thành phần tham dự: ${r.attendees}`,
        `4. Nội dung họp:\n${r.agenda}`,
        `5. Thảo luận:\n${r.discussion}`,
        `6. Kết luận:\n${r.conclusion}`,
        `Người lập: ${r.createdBy}`
      ].join("\n\n");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
      showToast("Đã sao chép nội dung báo cáo", "Sẵn sàng dán trực tiếp vào nhóm Zalo Chi đoàn / Đoàn Phường.");
    },

    openQRModal(meetingId) {
      const m = state.meetings.find((x) => x.id === meetingId);
      if (!m || m.status !== "Đang điểm danh" || (m.deadline && Date.now() >= m.deadline)) return showToast("Đã đóng điểm danh","Hạn điểm danh đã kết thúc.");
      if (!m.qrCode) return showToast("Đang tải mã QR","Thử lại sau khi đồng bộ.");
      displayedQr = m.id;
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Mã QR Điểm Danh</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div style="text-align:center;padding:10px 0;">
          <div style="font-size:14px;font-weight:700;margin-bottom:10px;">${escHtml(m.title)}</div>
          <div style="display:inline-block;padding:14px;background:#fff;border:2px solid var(--primary-light);border-radius:20px;box-shadow:var(--shadow-sm);">
            ${DoanQR.generateQRSvg(m.qrCode, 190)}
          </div>
          <div style="margin-top:10px;font-size:18px;font-weight:800;letter-spacing:2px;color:var(--primary);">${m.qrCode}</div>
          <div style="font-size:13px;color:var(--text-muted);margin:4px 0 14px;">
            Đã điểm danh: <strong id="qr-live-count" style="color:var(--success);font-size:15px;">${m.attendees}/${m.totalTarget}</strong> đoàn viên
          </div>

          <button class="btn-outline" style="width:100%;" onclick="App.closeModal()">Đóng</button>
        </div>
      `);
    },

    scanMeetingQr() {
      if (typeof window.AndroidBridge?.scanQr === "function") window.AndroidBridge.scanQr();
    },
    onQrScanResult(contents) {
      if (state.currentScreen !== "scan" || contents == null) return;
      App.performCheckIn(contents);
    },
    async performCheckIn(code) {
      const clean = String(code || "").trim().toUpperCase();
      const cloudCode = /^DVS-([A-F0-9]{24})-([A-Z0-9]{8,32})$/.exec(clean);
      if (cloudCode) {
        const id = cloudCode[1].toLowerCase();
        const meeting = state.meetings.find(item=>item.id === id);
        if (meeting?.deadline <= Date.now()) return showToast("Đã hết hạn điểm danh", meeting.title);
        const person = work.scanRoster(state.members).find(m=>m.id === state.scanMemberId);
        const owner = canManage() ? work.rosterKey(person) : firebaseSession.uid;
        if (!owner) return showToast("Chọn đoàn viên","Chọn người tham dự trước khi quét mã.");
        if (meeting?.attendedMemberIds.includes(owner)) return showToast("Đã điểm danh","Lượt tham dự đã được ghi nhận.");
        if (await sendWork("claim",{id,owner,code:cloudCode[2]})) showToast("Đã điểm danh","Đã ghi nhận trên Firestore.");
        return;
      }
      const m = state.meetings.find((x) => !x.cloud && clean && x.status === "Đang điểm danh" && x.qrCode === clean);
      if (!m) {
        showToast("Chưa nhận diện được mã điểm danh", /^SH-/.test(clean) ? "Đây là mã buổi sinh hoạt cũ lưu trên một thiết bị. Hãy dùng mã DVS do Bí thư cấp cho buổi đã đồng bộ." : "Quét QR của buổi sinh hoạt hoặc nhập đầy đủ mã DVS.");
        return;
      }
      const memberId = state.currentRoleId === "member" ? linkedMemberId() : state.scanMemberId;
      if (!state.members.some(person => person.id === memberId)) {
        showToast("Chưa xác định đoàn viên", "Chọn đoàn viên từ danh sách đã nhập trên thiết bị.");
        return;
      }
      if (m.attendedMemberIds.includes(memberId)) {
        showToast("Bạn đã điểm danh", "Lượt tham gia này đã được ghi nhận.");
        return;
      }
      {
        m.attendedMemberIds.push(memberId);
        m.attendees += 1;
        m.totalTarget = Math.max(m.totalTarget, state.members.length);
        const memberObj = state.members.find((x) => x.id === memberId);
        if (memberObj) {
          memberObj.points += m.points;
          memberObj.attendedCount += 1;
        }
        logAudit("checkin", m.title, `${memberObj.name} điểm danh QR (${clean}), +${m.points} điểm.`);
        saveState();
      }
      render();
      showToast("Điểm danh thành công!", `Đã ghi nhận tham dự và cộng +${m.points} điểm thi đua.`);
    },
    openMemberModal(memberId) {
      const m = findProfile(memberId);
      if (!m) return;
      const myRegs = state.registrations.filter((r) => r.cloud ? r.memberId === m.accountUid : r.memberId === m.id || r.submitterName === m.name);
      const myAwards = state.personalAchievements.filter((a) => a.cloud ? a.memberId === work.rosterKey(m) : a.memberId === m.id);

      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Hồ sơ Đoàn viên</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:17px;font-weight:800;">${escHtml(m.name)}</div>
          <div style="font-size:13px;color:var(--text-muted);">${m.id} ${m.birthYear ? "· Sinh năm " + escHtml(m.birthYear) : ""} · ${escHtml(m.group)}</div>
        </div>
        <div style="font-size:13px;line-height:1.7;margin-bottom:12px;background:#F8FAFC;padding:12px;border-radius:12px;">
          <div>${icon("phone")} Điện thoại: <strong>${escHtml(m.phone || "Chưa cập nhật")}</strong></div>
          <div>${icon("work")} Nghề nghiệp: <strong>${escHtml(m.job)}</strong></div>
          <div>${icon("work")} Ca làm việc: <strong>${escHtml(m.shift)}</strong></div>
          <div>${icon("star")} Điểm thi đua: <strong style="color:var(--primary);">${totalPoints(m,work.rosterKey(m))} điểm</strong></div>
        </div>
        <div style="margin-bottom:12px;">
          <div style="font-size:13px;font-weight:700;margin-bottom:5px;">Hồ sơ hoạt động & Thành tích (${myRegs.length + myAwards.length})</div>
          ${
            myRegs.length + myAwards.length === 0
              ? `<div style="font-size:12px;color:var(--text-muted);">Chưa có hồ sơ đăng ký hoặc khen thưởng riêng.</div>`
              : `
                ${myRegs.map((r) => `<div style="font-size:12px;padding:5px 8px;background:#EFF6FF;border-radius:8px;margin-bottom:4px;">${icon("edit")} ${escHtml(r.activityTitle)} (${r.profileCode})</div>`).join("")}
                ${myAwards.map((a) => `<div style="font-size:12px;padding:5px 8px;background:#ECFDF5;border-radius:8px;margin-bottom:4px;">${icon("award")} ${escHtml(a.title)} (+${a.points}đ)</div>`).join("")}
              `
          }
        </div>
        <div class="form-group">
          ${profileDetails(m)}
          ${canEditProfile(m.id) ? `<button class="btn-outline" onclick="App.editProfile('${m.id}')">Cập nhật hồ sơ</button>` : ""}
          </div>
      `);
    },
    editProfile(id) {
      const member = findProfile(id);
      if (!member || !canEditProfile(id)) return;
      const values = memberProfile(member);
      if (state.currentRoleId === "member") Object.assign(values, work.requests.find(r=>r.owner===member.accountUid && r.status==="pending")?.changes);
      const today = new Date().toLocaleDateString("sv-SE");
      openModal(`<h3>Cập nhật thông tin cá nhân</h3><form class="profile-form" onsubmit="event.preventDefault();App.saveProfile('${id}', this)">
        ${Object.entries(profileFields).map(([key, label]) => {
          if (key === "status") return `<label class="form-label">${label}<select class="form-control" name="status"><option value="" disabled ${values.status ? "" : "selected"}>Chưa cập nhật</option>${Object.entries(memberStatuses).map(([key,text])=>`<option value="${key}" ${values.status===key ? "selected" : ""}>${text}</option>`).join("")}</select></label>`;
          const attributes = {
            phone: member.accountUid ? 'type="tel" autocomplete="tel"' : 'readonly',
            name: 'required maxlength="100" autocomplete="name"',
            citizenId: 'inputmode="numeric" pattern="[0-9]{12}" maxlength="12" title="Số căn cước gồm 12 chữ số"',
            birthDate: `type="date" max="${today}"`,
            address: 'maxlength="250" autocomplete="street-address"'
          };
          return `<label class="form-label">${label}
            <input class="form-control" name="${key}" ${attributes[key] || 'maxlength="150"'} value="${escHtml(values[key])}">
            ${key === "birthDate" && !values.birthDate && values.birthYear ? `<small>Năm sinh đã lưu: ${escHtml(values.birthYear)}</small>` : ""}
          </label>`;
        }).join("")}
        <button class="btn-primary">${canManage() ? "Lưu thay đổi" : "Gửi yêu cầu phê duyệt"}</button>
        <button type="button" class="btn-outline" onclick="App.closeModal()">Hủy</button></form>`);
    },
    async saveProfile(id, form) {
      const member = findProfile(id);
      if (!member || !canEditProfile(id)) return;
      const current = memberProfile(member);
      const changes = {};
      if (!form.reportValidity()) return;
      for (const key of Object.keys(profileFields)) {
        const raw = form.elements[key].value.trim();
        const value = key === "phone" ? DoanFeatures.phoneKey(raw) : raw;
        if (key === "phone" && value !== (current.phone || "") && !/^0\d{9,10}$/.test(value)) return showToast("Số điện thoại chưa hợp lệ", "Nhập số bắt đầu bằng 0 hoặc +84.");
        if (!value && key === "name") return showToast("Thiếu thông tin", profileFields[key]);
        if (value !== (current[key] ?? "")) changes[key] = value;
      }
      if (member.accountUid) {
        if (!Object.keys(changes).length) return showToast("Chưa có thay đổi","Hãy cập nhật ít nhất một trường.");
        const manager = canManage();
        if (!await sendWork(manager ? "editPerson" : "profileRequest",{id:member.accountUid,rosterPhone:member.rosterPhone,changes,version:work.newId()})) return;
        closeModal();
        showToast("Hồ sơ cá nhân",manager ? "Đã cập nhật trên Firebase." : "Đã gửi yêu cầu cho cán bộ đơn vị.");
        return;
      }
      if (member.rosterPhone) {
        if (Object.keys(changes).length && await sendWork("editRoster",{id:member.rosterPhone,changes})) closeModal();
        return;
      }
      if (canManage()) {
        applyProfile(state.members.find(m=>m.id===id), changes);
        delete state.profileRequests[id];
      } else if (Object.keys(changes).length) state.profileRequests[id] = changes;
      else delete state.profileRequests[id];
      saveState();
      closeModal();
      render();
      showToast("Hồ sơ cá nhân", state.profileRequests[id] ? "Đã lưu yêu cầu cập nhật trên thiết bị." : "Đã lưu hồ sơ.");
    },
    async decideProfile(id,version,approve) {
      const rosterPhone = work.scanRoster(state.members).find(m=>m.accountUid===id)?.rosterPhone;
      if (canManage() && await sendWork("reviewProfile",{id,version,approve,rosterPhone})) showToast("Cập nhật hồ sơ",approve ? "Đã phê duyệt." : "Đã từ chối.");
    },
    reviewProfile(id, approve) {
      const changes = state.profileRequests[id];
      const member = state.members.find(m => m.id === id);
      if (!canManage() || !changes || !member) return;
      if (approve) applyProfile(member, changes);
      delete state.profileRequests[id];
      saveState();
      render();
      showToast("Cập nhật hồ sơ", approve ? "Đã phê duyệt." : "Đã từ chối.");
    },
    async toggleMakeup(id) {
      const ms = state.makeupSessions.find((x) => x.id === id);
      if (!ms || (!ms.registered && ms.slotsLeft < 1)) return;
      if (!ms.registered && conflictsWithShift(ms.time, state.workerShift, ms.endTime)) return showToast("Trùng ca làm việc","Chọn buổi bù khác.");
      if (ms.cloud) {
        if (await sendWork("book",{id,reserve:!ms.registered})) showToast("Đã cập nhật đăng ký",ms.title);
        return;
      }
      ms.registered = !ms.registered;
      ms.slotsLeft += ms.registered ? -1 : 1;
      logAudit("update", ms.title, ms.registered ? "Đăng ký tham gia buổi sinh hoạt bù." : "Hủy đăng ký sinh hoạt bù.");
      saveState();
      render();
      showToast(ms.registered ? "Đăng ký sinh hoạt bù thành công" : "Đã hủy đăng ký", ms.title);
    },
    async completeVolunteer(id) {
      const va = state.volunteerActivities.find((x) => x.id === id);
      if (!va || va.completed) return;
      if (va.cloud) {
        if (await sendWork("claim",{id})) showToast("Đã check-in","Đã ghi nhận "+va.points+" điểm cho tài khoản của bạn.");
        return;
      }
      const member = state.members.find(m => m.id === linkedMemberId());
      if (!member) state.personalCredit = (state.personalCredit || 0) + va.points;
      va.completed = true;
      if (member) member.points += va.points;
      logAudit("checkin", va.title, `Check-in hoạt động tình nguyện, cộng +${va.points} điểm.`);
      saveState();
      render();
      showToast("Tích điểm thành công!", `Bạn vừa nhận +${va.points} điểm thi đua từ hoạt động tình nguyện.`);
    },

    markAllRead() {
      state.readUnitNotices ||= {};
      state.notifications.forEach(n => { n.unread = false; if (n.cloud) state.readUnitNotices[n.id] = true; });
      saveState();
      render();
    },
    updateFeedbackDraft(field, value) {
      if (!feedbackBusy && ["title","body"].includes(field)) currentFeedbackDraft()[field] = value;
    },
    async submitFeedback() {
      if (feedbackBusy || !firebaseSession) return;
      const draft = currentFeedbackDraft();
      draft.title = document.getElementById("fb-title").value.trim();
      draft.body = document.getElementById("fb-body").value.trim();
      if (!draft.title || !draft.body || draft.title.length > 120 || draft.body.length > 4000)
        return showToast("Kiểm tra góp ý", "Nhập tiêu đề tối đa 120 ký tự và nội dung tối đa 4.000 ký tự.");
      const identity = firebaseSession;
      feedbackBusy = true;
      render();
      try {
        await work.write("feedback", {id:draft.id,title:draft.title,body:draft.body});
        if (firebaseSession !== identity) return;
        feedbackDraft = null;
        showToast("Đã gửi góp ý", "Góp ý đã được gửi đến cán bộ quản lý chi đoàn.");
      } catch (error) {
        if (firebaseSession === identity) showToast("Chưa xác nhận gửi góp ý", error.message);
      } finally {
        if (firebaseSession === identity) {
          feedbackBusy = false;
          if (state.currentScreen === "feedback") render();
        }
      }
    },
    async receiveFeedback(id, button) {
      if (!canManage()) return;
      button.disabled = true;
      try {
        if (await sendWork("receiveFeedback",{id})) showToast("Đã tiếp nhận", "Đoàn viên sẽ thấy trạng thái tiếp nhận.");
      } finally { button.disabled = false; }
    },
    exportWardCSV() {
      const csv = DoanFeatures.encodeCsv(wardReport());
      DoanFeatures.downloadBlob(new Blob([csv], {type: "text/csv;charset=utf-8"}), `Sinh_hoat_${state.wardMonth}.csv`);
    },
    printOfficialWardReport() {
      const [headers, ...rows] = wardReport();
      const role = getCurrentRole();
      DoanFeatures.printAdminReport("Báo cáo sinh hoạt " + state.wardMonth, role.unit, headers, rows, role.userName);
    },

    // ====== HANDLERS ĐĂNG KÝ, DUYỆT, MINH CHỨNG, LỊCH, THÀNH TÍCH, CSV, AUDIT ======
    setRegisterTab(t) {
      state.registerTab = t;
      render();
    },
    setRegisterCat(c) {
      state.registerCatFilter = c;
      render();
    },
    openRegisterModal(actId) {
      const act = state.activities.find((a) => a.id === actId);
      if (!act) return;
      const role = getCurrentRole();
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Đăng ký tham gia hoạt động</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div style="font-size:13.5px;font-weight:700;color:var(--primary);margin-bottom:10px;">${escHtml(act.title)}</div>
        <div class="form-group">
          <label class="form-label">Hình thức đăng ký</label>
          <select id="reg-type" class="form-control">
            <option value="individual">Đăng ký cá nhân Đoàn viên</option>
            <option value="collective">Đăng ký tập thể Chi đoàn / Tổ</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Họ và tên người đăng ký <span class="req">*</span></label>
          <input id="reg-name" class="form-control" value="${escHtml(role.userName)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Chi đoàn / Tổ trực thuộc <span class="req">*</span></label>
          <input id="reg-unit" class="form-control" value="${escHtml(role.unit)}" />
        </div>
        <div class="form-group">
          <label class="form-label">Ghi chú / Ca làm việc / Số lượng tập thể</label>
          <textarea id="reg-notes" class="form-control" rows="3" placeholder="VD: Đăng ký tham gia sáng Chủ nhật, không trùng ca KCN..."></textarea>
        </div>
        <button class="btn-primary" onclick="App.submitRegistration('${act.id}')">Gửi đăng ký & Cấp Mã hồ sơ</button>
      `);
    },
    async submitRegistration(actId) {
      const act = state.activities.find((a) => a.id === actId);
      if (!act || act.deadline < localDate()) return showToast("Đã hết hạn đăng ký", "Chọn hoạt động còn mở.");
      const name = document.getElementById("reg-name").value.trim();
      const unit = document.getElementById("reg-unit").value.trim();
      const type = document.getElementById("reg-type").value;
      const notes = document.getElementById("reg-notes").value.trim();
      if (!name || !unit) {
        showToast("Thiếu thông tin", "Vui lòng nhập họ tên và đơn vị.");
        return;
      }
      const code = DoanFeatures.generateProfileCode();
      const newReg = {
        id: "REG-" + Date.now(),
        profileCode: code,
        activityId: act.id,
        activityTitle: act.title,
        submitterName: name,
        memberId: linkedMemberId() || "",
        phone: getCurrentRole().phone,
        unitName: unit,
        registrationType: type,
        notes: notes || "Đăng ký tham gia hoạt động Đoàn",
        status: "pending",
        rejectReason: "",
        submittedAt: new Date().toISOString()
      };
      if (act.cloud) {
        const button = document.getElementById("modal-root").querySelector("[onclick^='App.submitRegistration']");
        const id = button.dataset.applicationId ||= work.newId();
        const sent = await sendWork("apply",{...newReg,id,event:act.id,phone:newReg.phone || ""});
        if (!sent) return;
      } else state.registrations.unshift(newReg);
      state.lookupCode = code;
      logAudit("create", `Hồ sơ ${code}`, `${name} đăng ký hoạt động '${act.title}'.`);
      saveState();
      render();
      openModal(`
        <div style="text-align:center;">
          <div style="font-size:34px;margin-bottom:4px;">${icon("check")}</div>
          <h3 style="font-size:17px;font-weight:800;margin-bottom:4px;">Đăng ký thành công!</h3>
          <p style="font-size:12.5px;color:var(--text-muted);">Lưu Mã hồ sơ bên dưới để tra cứu trạng thái phê duyệt:</p>
          <div class="receipt-box">
            <div style="font-size:11px;font-weight:700;color:var(--primary);">MÃ HỒ SƠ ĐĂNG KÝ</div>
            <div class="receipt-code">${code}</div>
            <div style="font-size:12px;color:#475569;">${escHtml(act.title)}</div>
          </div>
          <button class="btn-primary" style="margin-bottom:8px;" onclick="App.downloadReceipt('${newReg.id}')">${icon("image")} Tải Phiếu đăng ký (.PNG)</button>
          <button class="btn-outline" style="width:100%;" onclick="App.closeModal();App.setRegisterTab('lookup');">Tra cứu hồ sơ ngay</button>
        </div>
      `);
    },
    downloadReceipt(regId) {
      const reg = state.registrations.find((r) => r.id === regId);
      if (!reg) return;
      DoanFeatures.downloadReceiptPng(reg);
      showToast("Đã gửi yêu cầu lưu", `Đang xuất Phieu_Dang_Ky_${reg.profileCode}.png.`);
    },
    searchProfileCode() {
      const input = document.getElementById("lookup-code-input");
      if (input) state.lookupCode = input.value.trim().toUpperCase();
      render();
    },
    quickLookupCode(code) {
      state.lookupCode = code;
      render();
    },
    async cancelRegistration(regId) {
      const idx = state.registrations.findIndex((r) => r.id === regId);
      if (idx === -1) return;
      const removed = state.registrations[idx];
      if (removed.cloud) {
        if (!await sendWork("withdraw",{id:regId})) return;
      } else state.registrations.splice(idx, 1);
      logAudit("update", `Hủy hồ sơ ${removed.profileCode}`, `Đã hủy đăng ký hoạt động '${removed.activityTitle}'.`);
      saveState();
      render();
      showToast("Đã hủy hồ sơ", `Hồ sơ ${removed.profileCode} đã được rút khỏi danh sách chờ.`);
    },
    setApprovalFilter(f) {
      state.approvalFilter = f;
      render();
    },
    async approveRegistration(regId) {
      if (state.currentRoleId === "member") return;
      const r = state.registrations.find((x) => x.id === regId);
      if (!r) return;
      if (r.cloud) {
        if (!await sendWork("decide",{id:regId,status:"approved"})) return;
      } else { r.status = "approved"; r.rejectReason = ""; }
      logAudit("approve", `Hồ sơ ${r.profileCode}`, `Phê duyệt đăng ký cho ${r.submitterName}.`);
      saveState();
      render();
      showToast("Đã phê duyệt", `Hồ sơ ${r.profileCode} (${r.submitterName}) đã được duyệt.`);
    },
    async approveAllRegistrations() {
      if (state.currentRoleId === "member") return;
      const pendings = state.registrations.filter((r) => r.status === "pending");
      if (!pendings.length) return;
      for (const r of pendings) {
        if (r.cloud) {
          if (!await sendWork("decide",{id:r.id,status:"approved"})) { saveState(); return; }
        } else { r.status = "approved"; r.rejectReason = ""; }
      }
      logAudit("approve", `Duyệt hàng loạt (${pendings.length} hồ sơ)`, "Phê duyệt toàn bộ hồ sơ đăng ký đang chờ.");
      saveState();
      render();
      showToast("Đã duyệt hàng loạt", `Phê duyệt thành công ${pendings.length} hồ sơ đăng ký.`);
    },
    openRejectModal(regId) {
      if (state.currentRoleId === "member") return;
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Từ chối hồ sơ đăng ký</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div class="form-group">
          <label class="form-label">Lý do từ chối <span class="req">*</span></label>
          <textarea id="reject-reason-input" class="form-control" rows="3" placeholder="VD: Đã đủ số lượng đại biểu hoặc trùng lịch công tác..."></textarea>
        </div>
        <button class="btn-accent" onclick="App.rejectRegistration('${regId}')">Xác nhận từ chối</button>
      `);
    },
    async rejectRegistration(regId) {
      if (state.currentRoleId === "member") return;
      const r = state.registrations.find((x) => x.id === regId);
      const reason = (document.getElementById("reject-reason-input").value || "").trim() || "Không đủ điều kiện tham gia";
      if (!r) return;
      if (r.cloud) {
        if (!await sendWork("decide",{id:regId,status:"rejected",reason})) return;
      } else { r.status = "rejected"; r.rejectReason = reason; }
      logAudit("reject", `Hồ sơ ${r.profileCode}`, `Từ chối hồ sơ của ${r.submitterName}: ${reason}`);
      saveState();
      closeModal();
      render();
      showToast("Đã từ chối hồ sơ", `Đã lưu lý do từ chối cho hồ sơ của ${r.submitterName}.`);
    },
    setEvidenceFilter(f) {
      state.evidenceFilter = f;
      render();
    },
    openSubmitEvidenceModal() {
      pendingEvidenceImage = "";
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Nộp minh chứng hoạt động</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div class="form-group">
          <label class="form-label">Chọn hoạt động <span class="req">*</span></label>
          <select id="ev-act-id" class="form-control">
            ${[...state.activities,...state.volunteerActivities].map((a) => `<option value="${a.id}">${escHtml(a.title)}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Mô tả minh chứng <span class="req">*</span></label>
          <textarea id="ev-desc" class="form-control" rows="3" placeholder="VD: Ảnh chụp cùng Tổ 2 tại điểm ra quân Chủ nhật xanh..."></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Tải ảnh minh chứng trực tiếp (tự động nén)</label>
          <input type="file" accept="image/*" class="form-control" onchange="App.handleEvidenceImage(this)" />
          <div id="ev-img-preview" style="margin-top:6px;font-size:12px;color:var(--success);"></div>
        </div>
        <div class="form-group">
          <label class="form-label">Hoặc dán link kho ảnh (tùy chọn)</label>
          <input id="ev-link" class="form-control" placeholder="https://..." />
        </div>
        <button class="btn-primary" onclick="App.submitEvidence()">Gửi minh chứng</button>
      `);
    },
    handleEvidenceImage(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      DoanFeatures.compressImageToDataUrl(file)
        .then((dataUrl) => {
          pendingEvidenceImage = dataUrl;
          const prev = document.getElementById("ev-img-preview");
          if (prev) {
            prev.innerHTML = `✓ Đã nén ảnh thành công:<br><img src="${dataUrl}" class="evidence-thumb" />`;
          }
        })
        .catch((err) => showToast("Lỗi tải ảnh", err.message));
    },
    async submitEvidence() {
      const actId = document.getElementById("ev-act-id").value;
      const desc = document.getElementById("ev-desc").value.trim();
      const driveUrl = document.getElementById("ev-link").value.trim();
      if (!actId) return showToast("Chưa có hoạt động", "Tạo hoạt động trước khi nộp minh chứng.");
      if (!desc) {
        showToast("Thiếu mô tả", "Vui lòng nhập mô tả minh chứng.");
        return;
      }
      const act = [...state.activities,...state.volunteerActivities].find(a => a.id === actId);
      const role = getCurrentRole();
      if (act?.cloud) {
        const submit = document.getElementById("ev-act-id");
        const id = submit.dataset.proofId ||= work.newId();
        if (await sendWork("evidence",{id,event:actId,name:role.userName,description:desc,image:pendingEvidenceImage,link:driveUrl})) {
          pendingEvidenceImage = ""; closeModal(); showToast("Đã gửi minh chứng","Cán bộ đơn vị có thể xét duyệt.");
        }
        return;
      }
      state.evidences.unshift({
        id: "EV-" + Date.now(),
        activityId: actId,
        activityTitle: act ? act.title : "Hoạt động Đoàn",
        submitterName: role.userName,
        memberId: linkedMemberId() || "",
        unitName: role.unit,
        description: desc,
        driveUrl,
        imageDataUrl: pendingEvidenceImage,
        status: "pending",
        reviewNote: "",
        submittedAt: new Date().toISOString()
      });
      pendingEvidenceImage = "";
      logAudit("create", `Minh chứng: ${act ? act.title : actId}`, `${escHtml(role.userName)} đã nộp minh chứng hoạt động.`);
      saveState();
      closeModal();
      render();
      showToast("Đã lưu minh chứng", "Minh chứng được lưu trên thiết bị này.");
    },
    async reviewEvidence(evId, status) {
      const ev = state.evidences.find((x) => x.id === evId);
      if (!canManage() || ev?.status !== "pending" || !["verified", "revision"].includes(status)) return;
      if (ev.cloud) {
        if (await sendWork("review",{id:evId,status})) showToast("Đã duyệt minh chứng",status === "verified" ? "Đã ghi nhận 15 điểm cho người nộp." : "Đã yêu cầu bổ sung.");
        return;
      }
      if (status === "verified" && !state.members.some(m => m.id === ev.memberId)) {
        if (ev.submitterName !== getCurrentRole().userName) return showToast("Chưa xác định người nhận điểm","Cần đối chiếu hồ sơ người nộp trước khi duyệt.");
        ev.memberId = "";
      }
      ev.status = status;
      ev.reviewNote =
        status === "verified"
          ? "Minh chứng hợp lệ, đã xác nhận và cộng +15 điểm thi đua."
          : "Vui lòng bổ sung thêm ảnh chụp rõ mặt hoặc danh sách điểm danh.";
      if (status === "verified") {
        const memberObj = state.members.find((m) => m.id === ev.memberId);
        if (memberObj) memberObj.points += 15;
      }
      logAudit(
        status === "verified" ? "approve" : "update",
        `Minh chứng của ${ev.submitterName}`,
        status === "verified" ? "Xác nhận minh chứng & cộng +15 điểm." : "Yêu cầu bổ sung minh chứng."
      );
      saveState();
      render();
      showToast(status === "verified" ? "Đã xác nhận minh chứng" : "Đã ghi yêu cầu bổ sung", ev.activityTitle);
    },
    openLightbox(evId) {
      const ev = state.evidences.find((x) => x.id === evId);
      if (!ev || !ev.imageDataUrl) return;
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <strong style="font-size:14px;">Ảnh minh chứng · ${escHtml(ev.submitterName)}</strong>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <img src="${ev.imageDataUrl}" class="lightbox-img" alt="Phóng to minh chứng" />
        <div style="font-size:12.5px;color:#4B5563;margin-top:10px;">${escHtml(ev.description)}</div>
      `);
    },
    changeCalMonth(delta) {
      state.calMonth += delta;
      if (state.calMonth < 0) {
        state.calMonth = 11;
        state.calYear -= 1;
      } else if (state.calMonth > 11) {
        state.calMonth = 0;
        state.calYear += 1;
      }
      render();
    },
    selectCalDate(iso) {
      state.calSelectedDate = iso;
      render();
    },
    setAchievementTab(t) {
      state.achievementTab = t;
      render();
    },
    openAddAchievementModal() {
      if (!canManage()) return;
      const roster = work.scanRoster(state.members);
      if (!roster.length) return showToast(work.rosterReady ? "Chưa có đoàn viên" : "Đang tải danh sách", work.error || (work.rosterReady ? "Đơn vị chưa có đoàn viên đăng ký hoặc được nhập từ CSV." : "Vui lòng thử lại khi đồng bộ xong."));
      openModal(`
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <h3 style="font-size:16px;font-weight:800;">Ghi nhận thành tích mới</h3>
          <button class="icon-btn" onclick="App.closeModal()">✕</button>
        </div>
        <div class="form-group">
          <label class="form-label">Đoàn viên đạt thành tích</label>
          <select id="ach-member" class="form-control">
            ${roster.map((m) => `<option value="${m.id}">${escHtml(m.name)} · ${escHtml(m.phone || "Chưa cập nhật SĐT")}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Tên giải thưởng / Giấy khen <span class="req">*</span></label>
          <input id="ach-title" maxlength="120" class="form-control" placeholder="VD: Giải Nhì Hội thi Thanh niên thanh lịch" />
        </div>
        <div class="form-group">
          <label class="form-label">Cấp khen thưởng</label>
          <select id="ach-level" class="form-control">
            <option value="Cấp chi đoàn">Cấp chi đoàn (+10đ)</option>
            <option value="Cấp phường">Cấp phường (+15đ)</option>
            <option value="Cấp thành phố" selected>Cấp thành phố (+25đ)</option>
            <option value="Cấp tỉnh">Cấp tỉnh (+30đ)</option>
          </select>
        </div>
        <button class="btn-primary" onclick="App.addAchievement(this)">Lưu thành tích & Cộng điểm</button>
      `);
    },
    async addAchievement(button) {
      if (!canManage()) return;
      const mId = document.getElementById("ach-member").value;
      const title = document.getElementById("ach-title").value.trim();
      const level = document.getElementById("ach-level").value;
      if (!title) {
        showToast("Thiếu thông tin", "Vui lòng nhập tên giải thưởng / giấy khen.");
        return;
      }
      const ptsMap = { "Cấp chi đoàn": 10, "Cấp phường": 15, "Cấp thành phố": 25, "Cấp tỉnh": 30 };
      const pts = ptsMap[level] || 15;
      const m = work.scanRoster(state.members).find(person => person.id === mId);
      if (!m || button.disabled) return;
      button.disabled = true;
      const ok = await sendWork("award",{id:work.newId(),owner:work.rosterKey(m),memberName:m.name,title,level,points:pts});
      button.disabled = false;
      if (!ok) return;
      logAudit("create", `Thành tích: ${title}`, `Ghi nhận ${level} cho ${m.name} (+${pts} điểm).`);
      saveState();
      closeModal();
      state.achievementTab = "personal";
      render();
      showToast("Đã ghi nhận thành tích", `Cộng +${pts} điểm thi đua cho ${m.name}.`);
    },
    downloadSampleCsv() {
      DoanFeatures.downloadSampleMembersCsv();
      showToast("Đã gửi yêu cầu lưu CSV", "Sau khi lưu, mở file bằng Excel hoặc Numbers để nhập danh sách đoàn viên.");
    },
    previewPaste() {
      if (state.currentRoleId === "member") return;
      inputRevision++;
      const result = DoanFeatures.parseMembersCsv(document.getElementById("csv-paste").value, work.importedRoster(state.members));
      csvPreviewRows = result.rows;
      csvPreviewError = result.error;
      render();
      if (canMatchMembers() && csvPreviewRows.length) App.refreshRegistrations();
    },
    handleCsvFileChange(input) {
      if (state.currentRoleId === "member") return;
      const file = input.files && input.files[0];
      if (!file) return;

      const revision = ++inputRevision;
      csvPreviewRows = [];
      csvPreviewError = "";
      render();
      const reader = new FileReader();
      reader.onload = () => {
        if (revision !== inputRevision) return;
        const res = DoanFeatures.parseMembersCsv(reader.result, work.importedRoster(state.members));
        csvPreviewError = res.error || "";
        csvPreviewRows = res.rows || [];
        render();
        if (canMatchMembers() && csvPreviewRows.length) App.refreshRegistrations();
      };
      reader.onerror = () => {
        if (revision !== inputRevision) return;
        csvPreviewRows = [];
        csvPreviewError = "Không thể đọc tệp CSV. Vui lòng chọn lại.";
        render();
      };
      reader.readAsText(file, "UTF-8");
    },

    async confirmCsvImport() {
      if (!canManage() || !csvPreviewRows.length) return;
      const records = csvPreviewRows;
      const identity = firebaseSession;
      const added = records.filter(r=>r.action==="create").length;
      const updated = records.length - added;
      // Each linked row can require a separate Firestore rule lookup in this batch.
      const batchSize = 15;
      for (let i=0; i<records.length; i+=batchSize) {
        if (identity !== firebaseSession || !await sendWork("importRoster",{id:"csv",records:records.slice(i,i+batchSize)})) return;
      }
      if (identity !== firebaseSession) return;
      logAudit("import", `Nhập CSV danh sách ĐV`, `Thêm mới ${added} đoàn viên, cập nhật ${updated} đoàn viên.`);
      csvPreviewRows = [];
      csvPreviewError = "";
      App.go("members");
      showToast("Nhập CSV thành công!", `Đã thêm mới ${added} và cập nhật ${updated} đoàn viên.`);
    },
    setAuditFilter(f) {
      state.auditFilter = f;
      render();
    },
    setAuditSearch(val) {
      state.auditSearch = val;
      render();
    },

    showToast,
    closeModal
  };

  window.App.onFirebaseLogin = function(result) {
    if (!firebaseLoginPending || storageKey) return;
    firebaseStatus(false);
    if (result?.retryProfile) {
      profileError = result.error;
      registrationPage = "retry";
      render();
      return;
    }
    if (result?.needsProfile && result.uid) {
      if (registrationPage === "profile" && registrationUid === result.uid) {
        firebaseStatus(false, "Chưa tìm thấy hồ sơ users/" + result.uid + " trên Firestore.");
        return;
      }
      registrationUid = result.uid;
      registrationPage = "profile";
      render();
      return;
    }
    if (!result?.success && registrationPage === "profile") {
      firebaseStatus(false, result?.error || "Chưa lưu được hồ sơ. Vui lòng thử lại.");
      return;
    }
    const role = {bi_thu:"secretary", doan_vien:"member", ward_officer:"ward_officer"}[result?.role];
    if (!result?.success || !result.uid || !role || !result.unitCode || !result.unitName) {
      window.AndroidBridge.firebaseSignOut();
      if (registrationPage === "retry") {
        registrationPage = "login";
        render();
      }
      firebaseStatus(false, result?.error || "Hồ sơ đơn vị chưa đầy đủ.");
      return;
    }
    registrationUid = "";
    registrationPage = "login";
    firebaseSession = {uid: result.uid, unitCode: result.unitCode, officer:role === "ward_officer"};
    storageKey = ["doan_firebase_v1", result.uid, result.unitCode, role].map(encodeURIComponent).join("/");
    state = loadState();
    const name = result.displayName || "Đoàn viên";
    state.currentRoleId = role;
    state.roles = [{id:role, userName:name, unit:result.unitName, phone:result.phone || "",
      avatarText:name.trim().split(/\s+/).slice(-2).map(word => word[0]).join(""), cardNo:"",
      roleName:roleLabels[role], subtitle:roleLabels[role] + " · " + result.unitName, color:"#005BAC"}];
    App.openTab("home");
    work.start(firebaseSession, canManage(), refreshUnitWork);
    if (firebaseSession.officer) DoanManagement.restoreUnit();
  };


  DoanManagement.init({
    session:()=>firebaseSession, manager:canManage, open:openModal, toast:showToast,
    changed:render, unitName:()=>getCurrentRole()?.unit || "",
    renameUnit(name) {
      const role = getCurrentRole();
      role.unit = name;
      role.subtitle = roleLabels[role.id] + " · " + name;
      saveState();
      render();
    },
    selectUnit(unit) {
      if (!firebaseSession?.officer || entryBusy) return false;
      if (firebaseSession.unitCode === unit.id) { closeModal(); return true; }
      closeModal();
      saveState();
      work.reset();
      feedbackDraft = null;
      feedbackBusy = false;
      const previousRole = getCurrentRole();
      firebaseSession = {...firebaseSession,unitCode:unit.id};
      storageKey = ["doan_firebase_v1",firebaseSession.uid,unit.id,"ward_officer"].map(encodeURIComponent).join("/");
      state = loadState();
      state.currentRoleId = "ward_officer";
      state.roles = [{...previousRole,unit:unit.name,subtitle:roleLabels.ward_officer+" · "+unit.name}];
      directoryRequest++;
      directoryByPhone = null;
      routes.length = 0;
      App.openTab("home");
      work.start(firebaseSession,true,refreshUnitWork);
    }
  });
  render();
  if (window.AndroidBridge?.firebaseCanResume?.()) {
    firebaseStatus(true, "Đang khôi phục đăng nhập…");
    window.AndroidBridge.firebaseRetryProfile();
  }
})();
