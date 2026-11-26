// Tiện ích mở rộng chuyển thể từ hệ thống Đoàn Trường Số (chạy 100% offline)
window.DoanFeatures = (function () {
  const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

  function downloadBlob(blob, fileName) {
    if (window.AndroidBridge && typeof window.AndroidBridge.saveBase64File === "function") {
      const reader = new FileReader();
      reader.onload = () => window.AndroidBridge.saveBase64File(
        reader.result, fileName, blob.type.split(";")[0] || "application/octet-stream"
      );
      reader.onerror = () => window.App?.showToast("Không thể lưu tệp", "Không đọc được dữ liệu xuất.");
      reader.readAsDataURL(blob);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function generateProfileCode(yearSuffix = String(new Date().getFullYear()).slice(-2)) {
    let part = "";
    for (let i = 0; i < 6; i++) {
      part += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return `HS-${yearSuffix}-${part}`;
  }

  function wrapLines(ctx, text, maxWidth) {
    const lines = [];
    for (const paragraph of String(text || "—").split(/\r?\n/)) {
      let line = "";
      for (const word of paragraph.trim().split(/\s+/)) {
        const candidate = line ? line + " " + word : word;
        if (line && ctx.measureText(candidate).width > maxWidth) {
          lines.push(line);
          line = word;
        } else line = candidate;
      }
      lines.push(line);
    }
    return lines;
  }

  // Tải Phiếu xác nhận đăng ký dạng ảnh PNG
  function downloadReceiptPng(receipt) {
    const canvas = document.createElement("canvas");
    canvas.width = 960;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      window.App?.showToast("Không thể lưu phiếu", "Không thể tạo ảnh PNG.");
      return;
    }
    const valueFont = "bold 16px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.font = valueFont;
    const fields = [
      ["Hoạt động:", receipt.activityTitle],
      ["Đoàn viên / Chi đoàn:", [receipt.submitterName, receipt.unitName].filter(Boolean).join(" · ")],
      ["Hình thức đăng ký:", receipt.registrationType === "collective" ? "Đăng ký tập thể Chi đoàn" : "Đăng ký cá nhân Đoàn viên"],
      ["Nội dung / Ghi chú:", receipt.notes || "Đăng ký tham gia hoạt động"],
      ["Thời gian ghi nhận:", new Date(receipt.submittedAt).toLocaleString("vi-VN")]
    ].map(([label, value]) => [label, wrapLines(ctx, value, 610)]);
    const rowsHeight = fields.reduce((sum, [, lines]) => sum + lines.length * 24 + 10, 0);
    canvas.height = Math.max(620, 304 + rowsHeight + 102);

    ctx.fillStyle = "#F3F5F9";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#CBD5E1";
    ctx.lineWidth = 2;
    ctx.fillRect(32, 32, 896, canvas.height - 64);
    ctx.strokeRect(32, 32, 896, canvas.height - 64);

    ctx.fillStyle = "#005BAC";
    ctx.fillRect(32, 32, 896, 108);

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 26px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("PHIẾU XÁC NHẬN ĐĂNG KÝ HOẠT ĐỘNG ĐOÀN", 64, 82);
    ctx.fillStyle = "#DBEAFE";
    ctx.font = "600 16px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("ĐOÀN VIÊN SỐ", 64, 114);

    ctx.fillStyle = "#EFF6FF";
    ctx.strokeStyle = "#93C5FD";
    ctx.lineWidth = 2;
    ctx.fillRect(64, 162, 832, 98);
    ctx.strokeRect(64, 162, 832, 98);

    ctx.fillStyle = "#005BAC";
    ctx.font = "bold 15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText("MÃ HỒ SƠ CỦA BẠN (DÙNG ĐỂ TRA CỨU & BỔ SUNG HỒ SƠ)", 88, 194);

    ctx.fillStyle = "#0F172A";
    ctx.font = "bold 36px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(receipt.profileCode, 88, 240);

    let y = 304;
    fields.forEach(([label, lines]) => {
      ctx.fillStyle = "#475569";
      ctx.font = "600 16px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(label, 64, y);
      ctx.fillStyle = "#0F172A";
      ctx.font = valueFont;
      lines.forEach((line) => {
        ctx.fillText(line, 275, y, 610);
        y += 24;
      });
      y += 10;
    });

    ctx.fillStyle = "#E2E8F0";
    ctx.fillRect(64, canvas.height - 102, 832, 1);
    ctx.fillStyle = "#334155";
    ctx.font = "600 14px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(
      "Vui lòng lưu phiếu này. Mở mục 'Tra cứu hồ sơ' và nhập Mã hồ sơ để kiểm tra trạng thái duyệt.",
      64,
      canvas.height - 66
    );

    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, `Phieu_Dang_Ky_${receipt.profileCode}.png`);
      else window.App?.showToast("Không thể lưu phiếu", "Không thể tạo ảnh PNG.");
    }, "image/png");
  }

  // Nén ảnh minh chứng trước khi lưu localStorage
  function compressImageToDataUrl(file, maxDim = 720, quality = 0.68) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith("image/")) {
        reject(new Error("Vui lòng chọn đúng định dạng tệp ảnh (JPG, PNG, WEBP)."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Không thể đọc tệp ảnh."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("Ảnh không hợp lệ."));
        img.onload = () => {
          let w = img.width;
          let h = img.height;
          if (w > maxDim || h > maxDim) {
            const r = Math.min(maxDim / w, maxDim / h);
            w = Math.round(w * r);
            h = Math.round(h * r);
          }
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, w);
          canvas.height = Math.max(1, h);
          try {
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("Không thể xử lý ảnh.");
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          } catch (error) {
            reject(error);
          }
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function encodeCsv(rows) {
    const quote = (value) => '"' + String(value ?? "").replace(/"/g, '""') + '"';
    return "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
  }

  function readCsvRecords(source) {
    const firstLine = source.split(/[\r\n]/, 1)[0];
    const delimiter = firstLine.includes("\t") ? "\t" : firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
    const records = [];
    let cells = [];
    let value = "";
    let quoted = false;
    let closed = false;
    for (let i = 0; i <= source.length; i++) {
      const c = source[i];
      if (quoted) {
        if (c === undefined) throw new Error("Có ô CSV chưa đóng dấu ngoặc kép.");
        if (c !== '"') value += c;
        else if (source[i + 1] === '"') { value += '"'; i++; }
        else { quoted = false; closed = true; }
      } else if (c === delimiter || c === "\r" || c === "\n" || c === undefined) {
        cells.push(value.trim());
        value = "";
        closed = false;
        if (c === delimiter) continue;
        if (cells.some(Boolean)) records.push(cells);
        cells = [];
        if (c === "\r" && source[i + 1] === "\n") i++;
      } else if (c === '"' && !value.trim() && !closed) {
        value = "";
        quoted = true;
      } else if (c === '"' || (closed && c.trim())) {
        throw new Error("Dấu ngoặc kép trong ô CSV phải được viết thành hai dấu ngoặc kép.");
      } else {
        value += c;
      }
    }
    return records;
  }

  function plainText(value) {
    return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/đ/g, "d");
  }

  function phoneKey(value) {
    return String(value || "").replace(/[\s().-]/g, "").replace(/^\+84/, "0");
  }

  function parseMembersCsv(text, existingMembers) {
    try {
      const [header, ...records] = readCsvRecords(String(text || "").replace(/^\uFEFF/, "").trim());
      if (!records.length) throw new Error("File CSV cần có dòng tiêu đề và ít nhất một đoàn viên.");
      const headings = ["ho va ten", "nam sinh", "so dien thoai", "to", "nghe nghiep", "ca lam viec", "trang thai"];
      const labels = header.map(h => plainText(h).trim().replace(/\s*\(.+\)$/, ""));
      const positions = headings.map(h => labels.indexOf(h));
      if (positions.some(i => i < 0) || new Set(labels).size !== labels.length) {
        throw new Error("Thiếu cột bắt buộc hoặc tiêu đề trùng. Kiểm tra bảy cột trong biểu mẫu.");
      }
      if (records.length > 5000) throw new Error("Mỗi lần nhập tối đa 5000 đoàn viên.");
      const existing = new Map(existingMembers.map((m) => [phoneKey(m.phone), m]));
      const seen = new Set();
      const statuses = new Map([
        ["dia phuong", "local"], ["o dia phuong", "local"], ["local", "local"],
        ["di lam xa", "far"], ["far", "far"], ["chuyen sinh hoat", "transfer"], ["transfer", "transfer"]
      ]);
      const rows = records.map((cols, index) => {
        const rowNumber = index + 2;
        const fail = (message) => { throw new Error("Dòng dữ liệu " + rowNumber + ": " + message); };
        if (cols.length !== header.length) fail("Số cột khác với file mẫu.");
        const [name, year, rawPhone, group, job, shift, rawStatus] = positions.map(i => cols[i]);
        if (!name) fail("Thiếu họ và tên.");
        const phone = phoneKey(rawPhone);
        if (!/^0\d{9,10}$/.test(phone)) fail("Số điện thoại không hợp lệ. Giữ số 0 đầu hoặc dùng +84.");
        if (seen.has(phone)) fail("Số điện thoại trùng với một dòng khác trong file.");
        seen.add(phone);
        const member = existing.get(phone);
        if (!/^\d{4}$/.test(year) || +year < 1900 || +year > new Date().getFullYear()) fail("Năm sinh không hợp lệ.");
        const status = rawStatus ? statuses.get(plainText(rawStatus)) : member?.status;
        if (!status) fail("Trạng thái không hợp lệ. Hãy nhập Ở địa phương, Đi làm xa hoặc Chuyển sinh hoạt.");
        return {
          rowNumber, name, birthYear: +year, phone: member?.phone || phone,
          group: group || member?.group || "", job: job || member?.job || "",
          shift: shift || member?.shift || "", status, action: member ? "update" : "create"
        };
      });
      return { error: null, rows };
    } catch (error) {
      return { error: error.message, rows: [] };
    }
  }

  function downloadSampleMembersCsv() {
    const sample = [
      ["Ho va ten", "Nam sinh", "So dien thoai", "To", "Nghe nghiep", "Ca lam viec", "Trang thai (Dia phuong / Di lam xa / Chuyen sinh hoat)"],
      ["Nguyễn Văn A", "2002", "0912345678", "Tổ 1", "Công nhân", "Ca sáng (6h-14h)", "Ở địa phương"],
      ["Trần Thị B", "2000", "0987654321", "Tổ 2", "May mặc", "Ca chiều (14h-22h)", "Đi làm xa"]
    ];
    const csv = encodeCsv(sample);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, "Mau_Nhap_Doan_Vien.csv");
  }

  function printHtmlInIframe(html, jobName = "Bao_Cao_Doan_Vien_So") {
    if (window.AndroidBridge && typeof window.AndroidBridge.printHtml === "function") {
      window.AndroidBridge.printHtml(html, jobName);
      return;
    }
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow && iframe.contentWindow.document;
    if (doc) {
      doc.open();
      doc.write(html);
      doc.close();
      setTimeout(() => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => {
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }, 1500);
      }, 250);
    }
  }

  // In / Lưu PDF Báo cáo bảng thống kê chuẩn thể thức hành chính
  function printAdminReport(title, subtitle, headers, rows, creatorName) {
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const today = new Date();
    const dateStr = `Đồng Nai, ngày ${today.getDate()} tháng ${today.getMonth() + 1} năm ${today.getFullYear()}`;

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 15mm; }
  body { font-family: 'Times New Roman', serif; font-size: 12pt; color: #0F172A; line-height: 1.45; }
  .top { display: flex; justify-content: space-between; margin-bottom: 18px; font-size: 10.5pt; }
  .col { width: 48%; text-align: center; }
  .bold { font-weight: bold; }
  .line { width: 45%; border-bottom: 1px solid #0F172A; margin: 4px auto; }
  h1 { text-align: center; font-size: 14.5pt; color: #005BAC; margin: 12px 0 4px; text-transform: uppercase; }
  .sub { text-align: center; font-style: italic; font-size: 11pt; margin-bottom: 16px; color: #334155; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #334155; padding: 6px 8px; font-size: 10.5pt; }
  th { background: #F1F5F9; font-weight: bold; text-align: center; }
  .sign { display: flex; justify-content: space-between; margin-top: 28px; page-break-inside: avoid; }
  .sign-box { width: 45%; text-align: center; font-size: 11pt; }
</style>
</head>
<body>
  <div class="top">
    <div class="col">
      <div class="bold">${esc(subtitle)}</div>
      <div class="line"></div>
    </div>
    <div class="col">
      <div class="bold">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
      <div class="bold">Độc lập – Tự do – Hạnh phúc</div>
      <div class="line"></div>
    </div>
  </div>
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(subtitle)}</div>
  <table>
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>
      ${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}
    </tbody>
  </table>
  <div style="text-align:right;font-style:italic;margin-top:16px;font-size:10.5pt;">${dateStr}</div>
  <div class="sign">
    <div class="sign-box">
      <div class="bold">NGƯỜI LẬP BÁO CÁO</div>
      <div style="font-style:italic;font-size:10pt;">(Ký và ghi rõ họ tên)</div>
      <div style="margin-top:52px;" class="bold">${esc(creatorName)}</div>
    </div>
    <div class="sign-box">
      <div class="bold">NGƯỜI LẬP BÁO CÁO</div>
      <div style="font-style:italic;font-size:10pt;">(Ký tên và đóng dấu)</div>
    </div>
  </div>
</body>
</html>`;

    printHtmlInIframe(html);
  }

  // In / Lưu PDF Báo cáo nhanh sinh hoạt Chi đoàn theo mẫu 6 mục của Bí thư
  function printQuickReport(report, creatorName) {
    const esc = (v) =>
      String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\n/g, "<br>");

    const today = new Date();
    const dateStr = `Đồng Nai, ngày ${today.getDate()} tháng ${today.getMonth() + 1} năm ${today.getFullYear()}`;

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8" />
<title>Báo cáo nhanh sinh hoạt Chi đoàn</title>
<style>
  @page { size: A4 portrait; margin: 16mm; }
  body { font-family: 'Times New Roman', serif; font-size: 12.5pt; color: #0F172A; line-height: 1.5; }
  .top { display: flex; justify-content: space-between; margin-bottom: 18px; font-size: 11pt; }
  .col { width: 48%; text-align: center; }
  .bold { font-weight: bold; }
  .line { width: 45%; border-bottom: 1px solid #0F172A; margin: 4px auto; }
  h1 { text-align: center; font-size: 15pt; color: #005BAC; margin: 14px 0 4px; text-transform: uppercase; }
  .sub { text-align: center; font-style: italic; font-size: 11.5pt; margin-bottom: 18px; color: #334155; }
  .sec { margin-bottom: 12px; }
  .sec-title { font-weight: bold; color: #0F172A; margin-bottom: 3px; }
  .sec-body { padding-left: 12px; }
  .sign { display: flex; justify-content: flex-end; margin-top: 32px; page-break-inside: avoid; }
  .sign-box { width: 48%; text-align: center; font-size: 11.5pt; }
</style>
</head>
<body>
  <div class="top">
    <div class="col">
      <div class="bold">${esc(report.unit || "")}</div>
      <div class="line"></div>
    </div>
    <div class="col">
      <div class="bold">ĐOÀN TNCS HỒ CHÍ MINH</div>
      <div style="font-style:italic;">${dateStr}</div>
    </div>
  </div>
  <h1>BÁO CÁO NHANH SINH HOẠT CHI ĐOÀN</h1>
  <div class="sub">${esc(report.title || "Sinh hoạt Chi đoàn")}</div>

  <div class="sec"><div class="sec-title">1. Thời gian:</div><div class="sec-body">${esc(report.time)}</div></div>
  <div class="sec"><div class="sec-title">2. Địa điểm:</div><div class="sec-body">${esc(report.location)}</div></div>
  <div class="sec"><div class="sec-title">3. Thành phần tham dự:</div><div class="sec-body">${esc(report.attendees)}</div></div>
  <div class="sec"><div class="sec-title">4. Nội dung họp:</div><div class="sec-body">${esc(report.agenda)}</div></div>
  <div class="sec"><div class="sec-title">5. Thảo luận:</div><div class="sec-body">${esc(report.discussion)}</div></div>
  <div class="sec"><div class="sec-title">6. Kết luận:</div><div class="sec-body">${esc(report.conclusion)}</div></div>

  <div class="sign">
    <div class="sign-box">
      <div class="bold">TM. BAN CHẤP HÀNH CHI ĐOÀN</div>
      <div class="bold">BÍ THƯ</div>
      <div style="margin-top:56px;" class="bold">${esc(creatorName)}</div>
    </div>
  </div>
</body>
</html>`;

    printHtmlInIframe(html);
  }

  return {
    downloadBlob,
    encodeCsv,
    generateProfileCode,
    downloadReceiptPng,
    compressImageToDataUrl,
    phoneKey,
    parseMembersCsv,
    downloadSampleMembersCsv,
    printAdminReport,
    printQuickReport
  };
})();
