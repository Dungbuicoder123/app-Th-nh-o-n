// Danh mục dùng chung. Hồ sơ và các giao dịch được tạo trên thiết bị.
window.DOAN_DATA = (function () {
  const newsCategories = [
    "Trang chủ",
    "Tiêu điểm",
    "Gương sáng",
    "Chuyển đổi số",
    "Học tập",
    "Việc làm",
    "Công tác Đoàn"
  ];

  const activityCategories = [
    { id: "vol", name: "Tình nguyện – Cộng đồng", color: "#059669", bg: "#ECFDF5" },
    { id: "cul", name: "Văn hóa – Văn nghệ", color: "#DB2777", bg: "#FDF2F8" },
    { id: "spt", name: "Thể dục – Thể thao", color: "#EA580C", bg: "#FFF7ED" },
    { id: "edu", name: "Tuyên truyền – Giáo dục", color: "#005BAC", bg: "#EFF6FF" },
    { id: "dig", name: "Chuyển đổi số – Sáng tạo", color: "#7C3AED", bg: "#F5F3FF" },
    { id: "mov", name: "Công tác Đoàn – Phong trào", color: "#D97706", bg: "#FFFBEB" }
  ];

  return {
    newsCategories, activityCategories,
    roles: [], members: [], meetings: [], quickReports: [], makeupSessions: [],
    volunteerActivities: [], notifications: [], news: [], activities: [],
    registrations: [], evidences: [], personalAchievements: [],
    collectiveAchievements: [], auditLogs: []
  };
})();
