// Live Firestore records are projected into the screens; local records retain their original IDs.
window.DoanUnitWork = (() => {
  const groups = {meeting:"meetings", makeup:"makeupSessions", points:"volunteerActivities", register:"activities", news:"news"};
  const channels = ["events","keys","people","receipts","evidence","applications","profileRequests","self","roster","awards","secretaries","counts","unit","feedback"];
  const collections = [...Object.values(groups), "evidences", "notifications", "registrations", "personalAchievements"];
  let session, rows, ready, refresh, expiryTimer, busy = new Set(), errors;
  const pending = new Map();
  let legacyUploads;
  let sequence = 0;

  function reset() {
    clearTimeout(expiryTimer);
    pending.forEach(task => task.reject(Error("Phiên đăng nhập đã thay đổi.")));
    pending.clear();
    busy = new Set();
    legacyUploads = new Set();
    rows = Object.fromEntries(channels.map(key => [key, []]));
    ready = new Set();
    errors = new Map();
    session = null;
  }
  function start(identity, manager, changed) {
    reset();
    session = identity;
    refresh = changed;
    window.UnitWork.start(identity.uid, identity.unitCode, manager, identity.officer === true);
  }
  function snapshot(result) {
    if (!session || result.uid !== session.uid || (result.unitCode && result.unitCode !== session.unitCode) || !channels.includes(result.channel)) return;
    if (result.offline) {
      ready.delete(result.channel);
      errors.set(result.channel, "Đang chờ kết nối với Firestore để tải dữ liệu đơn vị.");
    } else if (result.error) {
      errors.set(result.channel, result.error);
      ready.delete(result.channel);
      rows[result.channel] = [];
    } else {
      errors.delete(result.channel);
      ready.add(result.channel);
      rows[result.channel] = result.rows;
    }
    refresh();
  }
  function write(op, body) {
    const key = op + "/" + body.id + "/" + (body.owner || "");
    if (busy.has(key)) return Promise.reject(Error("Thao tác đang được ghi nhận."));
    const set = busy;
    set.add(key);
    const id = ++sequence;
    return new Promise((resolve,reject) => {
      pending.set(id, {resolve,reject});
      window.UnitWork.submit(session.uid, id, op, JSON.stringify(body));
    }).finally(() => { set.delete(key); pending.delete(id); });
  }
  function complete(result) {
    if (session?.uid !== result.uid) return;
    const task = pending.get(result.requestId);
    if (result.error) task?.reject(Error(result.error));
    else task?.resolve();
  }
  function newId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2,"0")).join("");
  }
  function localOnly(state) {
    const copy = {...state};
    for (const name of collections) copy[name] = state[name].filter(item => !item.cloud);
    return copy;
  }
  async function syncLegacyFeed(state) {
    if (!session || !ready.has("events")) return;
    const identity = session;
    const attempted = legacyUploads;
    for (const [kind, items] of [["news",state.news],["register",state.activities]]) {
      for (const item of items) {
        if (identity !== session) return;
        if (item.cloud || attempted.has(item.id) || !/^[\w-]{1,100}$/.test(item.id)) continue;
        attempted.add(item.id);
        const createdAt = item.createdAt || Date.now();
        const content = kind === "news" ? {title:item.title,category:item.category,tag:item.category,date:item.date,
          content:item.content || item.summary || "",summary:item.summary || (item.content || "").slice(0,180),createdAt}
          : {title:item.title,category:item.category,date:item.date,deadline:item.deadline,location:item.location,
             status:item.status,description:item.description || "",createdAt};
        const deadline = kind === "register" ? Date.parse(item.deadline+"T23:59:59.999") : 0;
        try {
          await write("publishLegacy",{id:item.id,kind,content,deadline:deadline || 0,points:Number(item.points) || 0});
        } catch (e) {
          if (session !== identity) return;
          errors.set("legacy","Chưa đồng bộ được nội dung cũ: "+e.message);
          refresh();
          return;
        }
      }
    }
  }
  function memberUid(member) {
    if (!member || !rows) return "";
    if (member.accountUid) return member.accountUid;
    if (member.linkedUid && rows.people.some(person=>person.id===member.linkedUid)) return member.linkedUid;
    const normalize = value => String(value || "").trim().normalize("NFC").replace(/\s+/g," ").toLocaleLowerCase("vi");
    const phone = DoanFeatures.phoneKey(member.phone);
    const candidates = rows.people.filter(p => phone && DoanFeatures.phoneKey(p.phone) === phone);
    return candidates.length === 1 && normalize(candidates[0].name) === normalize(member.name) ? candidates[0].id : "";
  }
  function importedRoster(members) {
    const shared = new Map((rows?.roster || []).map(row => [row.phone,
      {...row, ...row.details, linkedUid:row.accountUid, accountUid:undefined, rosterPhone:row.phone, id:"csv-"+row.phone, points:0}]));
    const merged = members.map(member => {
      const phone = DoanFeatures.phoneKey(member.phone);
      const row = shared.get(phone);
      shared.delete(phone);
      return row ? {...member,...row,id:member.id,points:member.points} : member;
    });
    return merged.concat([...shared.values()]);
  }
  async function migrateRoster(members) {
    if (!ready.has("roster") || legacyUploads.has("csv-migration")) return;
    legacyUploads.add("csv-migration");
    const identity = session;
    const known = new Set(rows.roster.map(r => r.phone));
    const missing = members.map(m=>({...m,phone:DoanFeatures.phoneKey(m.phone)}))
      .filter(m=>/^0\d{9,10}$/.test(m.phone) && !known.has(m.phone));
    try {
      for (let i=0; i<missing.length && session===identity; i+=200)
        await write("migrateRoster",{id:"migration",records:missing.slice(i,i+200)});
    } catch (e) {
      if (session===identity) { errors.set("migration",e.message); refresh(); }
    }
  }
  function scanRoster(members) {
    const people = new Map((rows?.people || []).filter(p => /^[\w-]+$/.test(p.id)).map(p => [p.id,p]));
    const merged = importedRoster(members).map(member => {
      const uid = memberUid(member), person = people.get(uid);
      if (!person) return member;
      people.delete(uid);
      return {...member,...person.details,accountUid:uid,name:person.name,phone:person.phone};
    });
    for (const person of people.values()) merged.push(asMember(person));
    return merged;
  }
  function asMember(p) {
    return p && {unit:p.unit, ...p.details, id:"uid-" + p.id, accountUid:p.id, name:p.name, phone:p.phone || "", job:"", points:0};
  }
  function rosterKey(member) {
    return memberUid(member) || (member?.rosterPhone ? "csv-"+member.rosterPhone : "") || (member ? "local-" + session.uid + "-" + member.id : "");
  }
  function audience(state) {
    if (!ready.has("people")) throw Error("Chưa tải được danh sách tài khoản của đơn vị.");
    return [...new Set([...rows.people.map(p => p.id), ...scanRoster(state.members).map(rosterKey)])].filter(Boolean);
  }
  function points(uid) {
    if (!session || !uid) return 0;
    const values = new Map(rows.events.filter(e => ["meeting","points"].includes(e.kind)).map(e => [e.id,e.points]));
    return rows.receipts.reduce((sum,r) => sum + (r.owner === uid ? values.get(r.event) || 0 : 0),0)
      + rows.awards.reduce((sum,a)=>sum + (a.owner === uid ? a.points : 0),0)
      + 15 * rows.evidence.filter(e => e.owner === uid && e.status === "verified").length;
  }
  async function syncCounts(counts) {
    if (!ready.has("counts") || !ready.has("people") || !ready.has("roster") ||
        busy.has("countMembers/members/") || errors.has("countWrite")) return;
    if (Object.keys(counts).every(k=>rows.counts[0]?.[k] === counts[k])) return;
    const identity = session;
    try { await write("countMembers",{id:"members",...counts}); }
    catch (e) { if (session===identity) { errors.set("countWrite",e.message); refresh(); } }
  }
  function schedule(deadline) {
    clearTimeout(expiryTimer);
    if (Number.isFinite(deadline)) expiryTimer = setTimeout(refresh, Math.min(2147483647,Math.max(1,deadline-Date.now()+5)));
  }
  function project(state, manager) {
    if (!session) return;
    const local = localOnly(state), lists = Object.fromEntries(collections.map(k => [k,[]]));
    const now = Date.now(), uid = session.uid, read = state.readUnitNotices || {};
    let nextDeadline = Infinity;
    function notify(id,title,desc,at,action) {
      lists.notifications.push({cloud:true,id,title,desc,at,action,unread:!read[id],time:new Date(at).toLocaleString("vi-VN")});
    }
    const keys = new Map(rows.keys.map(k => [k.id,k.code]));
    const attendance = new Map();
    for (const r of rows.receipts) {
      if (!attendance.has(r.event)) attendance.set(r.event,[]);
      attendance.get(r.event).push(r.owner);
    }
    const titles = new Map();
    for (const e of rows.events) {
      if (!Object.prototype.hasOwnProperty.call(groups,e.kind) || !/^[\w-]+$/.test(e.id)) continue;
      let data;
      try { data = JSON.parse(e.content); } catch { continue; }
      const item = {...data, cloud:true, id:e.id, points:e.points};
      titles.set(e.id,item.title);
      const owners = attendance.get(e.id) || [];
      if (e.kind === "meeting") {
        const closed = now >= e.deadline;
        const target = Array.isArray(item.audience) ? item.audience : [];
        Object.assign(item,{deadline:e.deadline,status:closed ? "Đã kết thúc" : "Đang điểm danh",
          qrCode:keys.has(e.id) ? "DVS-" + e.id + "-" + keys.get(e.id) : "",
          attendedMemberIds:owners,attendees:owners.length,totalTarget:new Set([...target,...owners]).size});
        item.documents = state.localMeetingFiles?.[e.id] || (Array.isArray(item.documents) ? item.documents : []);
        if (!closed) {
          nextDeadline = Math.min(nextDeadline,e.deadline);
          notify("meeting-"+e.id,"Lịch sinh hoạt · "+item.title,item.time+" · "+item.location,item.createdAt);
        }
        if (closed && ready.has("receipts")) {
          const absent = target.filter(id => !owners.includes(id)).length;
          if (manager) notify("closed-"+e.id,"Đã chốt điểm danh · "+item.title,
            owners.length+" người tham dự, "+absent+" người vắng."+(absent ? " Vui lòng tạo lịch sinh hoạt bù." : ""),e.deadline,absent ? "createMakeup" : "");
          else if (target.includes(uid) && !owners.includes(uid)) notify("absent-"+e.id,"Vắng sinh hoạt · "+item.title,
            "Mở Sinh hoạt bù để kiểm tra lịch và đăng ký buổi phù hợp với ca làm việc.",e.deadline,"makeup");
        }
      } else if (e.kind === "news") {
        Object.assign(item,{bannerGradient:"#005BAC",liked:!!state.likedArticles?.[e.id],likes:state.likedArticles?.[e.id] ? 1 : 0});
        notify("news-"+e.id,"Bài viết mới · "+item.title,item.category,item.createdAt,"news");
      } else if (e.kind === "register") {
        notify("register-"+e.id,"Mở đăng ký · "+item.title,"Hạn đăng ký: "+item.deadline,item.createdAt,"register");
      } else if (e.kind === "points") {
        item.completed = owners.includes(uid);
        notify("points-"+e.id,"Hoạt động tình nguyện · "+item.title,item.location,item.createdAt,"points");
      }
      else if (e.kind === "makeup") {
        item.registered = owners.includes(uid);
        item.slotsLeft = e.capacity - e.booked;
        notify("makeup-"+e.id,"Lịch sinh hoạt bù · "+item.title,item.time+" · "+item.location,item.createdAt,"makeup");
      }
      lists[groups[e.kind]].push(item);
    }
    for (const a of rows.awards) {
      lists.personalAchievements.push({...a,cloud:true,memberId:a.owner,category:"Công tác Đoàn – Phong trào",
        date:new Date(a.at).toLocaleDateString("vi-VN")});
    }
    for (const r of rows.applications) {
      if (!/^[\w-]+$/.test(r.id) || !/^[\w-]+$/.test(r.profileCode)) continue;
      const title = titles.get(r.event) || "Hoạt động";
      lists.registrations.push({...r,cloud:true,memberId:r.owner,activityId:r.event,activityTitle:title,createdAt:r.at,submittedAt:new Date(r.at).toISOString()});
      if (manager && r.status === "pending") notify("application-"+r.id,"Đăng ký chờ duyệt · "+title,r.submitterName,r.at,"approvals");
      if (r.owner === uid && r.status !== "pending") notify(r.status+"-"+r.id,title,
        r.status === "approved" ? "Đăng ký đã được phê duyệt." : "Đăng ký bị từ chối: "+r.rejectReason,r.decidedAt || r.at,"register");
    }
    for (const item of rows.feedback) {
      if (manager && item.status === "pending") notify("feedback-"+item.id,"Góp ý chờ tiếp nhận · "+item.title,item.name,item.at,"feedback");
      if (item.owner === uid && item.status === "received") notify("received-feedback-"+item.id,"Góp ý đã được tiếp nhận",item.title,item.receivedAt || item.at,"feedback");
    }
    for (const r of rows.profileRequests) {
      if (manager && r.status === "pending") notify("profile-"+r.version,"Yêu cầu sửa hồ sơ",
        rows.people.find(p=>p.id===r.owner)?.name || "Đoàn viên trong đơn vị",r.at,"account");
      if (r.owner === uid && r.status !== "pending") notify(r.status+"-"+r.version,"Kết quả sửa hồ sơ",
        r.status === "approved" ? "Thông tin mới đã được duyệt." : "Yêu cầu đã bị từ chối.",r.at,"account");
    }
    for (const e of rows.evidence) {
      const title = titles.get(e.event) || "Hoạt động";
      const photo = typeof e.image === "string" && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(e.image) ? e.image : "";
      const reviewNote = e.status === "verified" ? "Đã cộng 15 điểm thi đua." : e.status === "revision" ? "Vui lòng bổ sung minh chứng." : "";
      lists.evidences.push({cloud:true,id:e.id,memberId:e.owner,submitterName:e.name,activityTitle:title,
        activityId:e.event,description:e.description,driveUrl:e.link,imageDataUrl:photo,status:e.status,reviewNote,createdAt:e.at,
        submittedAt:new Date(e.at).toISOString()});
      if (manager && e.status === "pending") notify("review-"+e.id,"Có minh chứng chờ duyệt",e.name+" · "+title,e.at);
      if (e.owner === uid && reviewNote) notify(e.status+"-"+e.id,title,reviewNote,e.at);
    }
    for (const name of collections) {
      lists[name].sort((a,b) => (b.createdAt||b.at||0)-(a.createdAt||a.at||0));
      const sharedIds = new Set(lists[name].map(item => item.id));
      state[name] = lists[name].concat(local[name].filter(item => !sharedIds.has(item.id)));
    }
    schedule(nextDeadline);
  }

  return {start,reset,syncCounts,migrateRoster,importedRoster,syncLegacyFeed,snapshot,write,complete,newId,project,localOnly,scanRoster,rosterKey,audience,points,
    get own() { return asMember(rows?.self[0]); },
    get rosterReady() { return ready?.has("people") && ready.has("roster"); },
    get unitName() { return rows?.unit[0]?.name; },
    get counts() { return rows?.counts[0]; },
    get secretaries() { return rows?.secretaries || []; },
    get requests() { return rows?.profileRequests || []; },
    get feedback() { return rows?.feedback || []; },
    get feedbackReady() { return ready?.has("feedback"); },
    get eventsReady() { return ready?.has("events"); },
    get error() { return errors?.values().next().value || ""; }};
})();