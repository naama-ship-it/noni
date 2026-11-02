/* בדיקת עשן — מריצים מול שרת מקומי במצב בדיקה:
   AUTH_MODE=none LLM_PROVIDER=mock DB_PORT=5433 PORT=8090 node server.js
   ואז: BASE=http://localhost:8090 node test/smoke.js */
const BASE = process.env.BASE || "http://localhost:8090";
const H = { "Content-Type": "application/json", "x-dev-user": process.env.USER_EMAIL || "test-user@example.com" };
let fails = 0;
async function call(method, path, body) { const r = await fetch(BASE + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); return r.json(); }
function check(name, cond) { console.log((cond ? "✓ " : "✗ ") + name); if (!cond) fails++; }
(async () => {
  const h = await call("GET", "/api/health"); check("health", h.ok);
  const b = await call("GET", "/api/bootstrap"); check("bootstrap + הצטרפות אוטומטית", b.ok && b.me && b.me.tenant.id);
  const t = await call("POST", "/api/tasks", { title: "בדיקה", dueDate: b.now.date, priority: 1 }); check("הוספת משימה", t.ok && t.task.id);
  const u = await call("PATCH", "/api/tasks/" + t.task.id, { status: "done" }); check("סימון כבוצעה", u.ok && u.task.status === "done");
  const r = await call("POST", "/api/reminders", { text: "בדיקה", remindAt: new Date(Date.now() - 1000).toISOString() }); check("תזכורת", r.ok);
  const d = await call("POST", "/api/reminders/due", {}); check("תזכורת שהגיע מועדה", d.ok && d.due.length >= 1);
  const c1 = await call("POST", "/api/chat", { message: "תוסיפי משימה להכין מבחן מחר" }); check("צ'אט → add_task", c1.ok && c1.tools.includes("add_task") && c1.tasks);
  const c2 = await call("POST", "/api/chat", { message: "מה המשימות", conversationId: c1.conversationId }); check("צ'אט → list_tasks באותה שיחה", c2.ok && c2.conversationId === c1.conversationId);
  const cfg = await call("GET", "/api/config"); check("config ציבורי", cfg.ok && "googleClientId" in cfg);
  const w0 = await call("GET", "/api/wa/link"); check("ווטסאפ — מצב התחלתי", w0.ok && w0.link.linked === false);
  const w1 = await call("POST", "/api/wa/link", { phone: "050-1234567" }); check("ווטסאפ — קוד קישור", w1.ok && /^\d{6}$/.test(w1.link.code) && w1.link.phone === "972501234567");
  const wbad = await call("POST", "/api/wa/link", { phone: "12" }); check("ווטסאפ — טלפון לא תקין → 400", wbad.ok === false);
  const wh = await fetch(BASE + "/api/wa/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc"); check("webhook — אימות נדחה בלי טוקן", wh.status === 403);
  const cr = await fetch(BASE + "/api/cron/reminders", { method: "POST" }).then(x => x.json()); check("cron בלי מפתח → 403", cr.ok === false);
  const w2 = await call("DELETE", "/api/wa/link"); check("ווטסאפ — ניתוק", w2.ok && w2.link.linked === false && !w2.link.code);
  const br = await call("POST", "/api/brief", {}); check("תדריך", br.ok && Array.isArray(br.tasks));
  const adm = await call("GET", "/api/admin/platform-rules"); check("משתמש/ת רגיל/ה חסומ/ה מניהול הפלטפורמה", adm.ok === false);
  const conv = await call("GET", "/api/conversations"); check("רשימת שיחות", conv.ok && conv.conversations.length >= 1);
  const cn = await call("GET", "/api/connections"); check("חיבורים — גוגל לא מחובר", cn.ok && cn.connections.google.connected === false);
  const c4 = await call("POST", "/api/chat", { message: "מה יש לי ביומן היום" }); check("יומן בלי חיבור → הפניה לחיבורים", c4.ok && /חיבור/.test(c4.answer));
  /* ---- משק בית: רשימות, תורנויות, הוצאות, תכנון ---- */
  const l1 = await call("POST", "/api/lists/items", { items: [{ text: "חלב" }, { text: "לחם", qty: "2" }, "ביצים"] }); check("רשימת קניות — הוספה", l1.ok && l1.lists[0] && l1.lists[0].items.length === 3 && l1.household.exists);
  const l2 = await call("POST", "/api/lists/items", { items: ["חלב"] }); check("רשימה — אין כפילויות", l2.ok && l2.lists[0].items.length === 3);
  const l3 = await call("POST", "/api/lists/check", { texts: ["חלב"] }); check("רשימה — סימון נקנה", l3.ok && l3.lists[0].items.find(i => i.text === "חלב").done === true);
  const l4 = await call("POST", "/api/lists/clear", {}); check("רשימה — ניקוי מסומנים", l4.ok && l4.lists[0].items.length === 2);
  const l5 = await call("POST", "/api/lists/items", { list: "לטיול", items: ["כובע"] }); check("רשימה נוספת", l5.ok && l5.lists.length === 2);
  const ch1 = await call("POST", "/api/chores", { title: "להוציא זבל", people: ["דנה", "יוסי"], cadence: "weekly" }); check("תורנות — יצירה", ch1.ok && ch1.chore.turn === "דנה");
  const ch2 = await call("POST", "/api/chores/" + ch1.chore.id, {}); check("תורנות — בוצע → התור עובר", ch2.ok && ch2.chore.turn === "יוסי" && ch2.chore.lastDoneBy === "דנה");
  const e1 = await call("POST", "/api/expenses", { amount: 120, category: "סופר", note: "שופרסל" }); check("הוצאה — רישום + מיפוי קטגוריה", e1.ok && e1.expense.category === "מזון" && e1.expenses.month.total >= 120);
  const e2 = await call("POST", "/api/expenses", { amount: "80.5", category: "דלק" }); check("הוצאה — מחרוזת סכום", e2.ok && e2.expense.amount === 80.5 && e2.expense.category === "רכב");
  const e3 = await call("GET", "/api/expenses"); check("הוצאות — רשימה ופילוח", e3.ok && e3.total >= 200 && e3.byCategory.length >= 2);
  const ebad = await call("POST", "/api/expenses", { amount: 0 }); check("הוצאה בלי סכום → 400", ebad.ok === false);
  const hh = await call("GET", "/api/household"); check("משק בית — קוד הזמנה", hh.ok && /^[A-Z0-9]{6}$/.test(hh.household.code) && hh.household.members.length === 1);
  const H2 = { "Content-Type": "application/json", "x-dev-user": "partner@example.com" };
  const j1 = await fetch(BASE + "/api/household/join", { method: "POST", headers: H2, body: JSON.stringify({ code: hh.household.code }) }).then(x => x.json()); check("בן/בת זוג — הצטרפות בקוד", j1.ok && j1.household.members.length === 2 && j1.lists.length === 2);
  const jbad = await fetch(BASE + "/api/household/join", { method: "POST", headers: H2, body: JSON.stringify({ code: "ZZZZZZ" }) }).then(x => x.json()); check("קוד שגוי → שגיאה", jbad.ok === false);
  const e4 = await fetch(BASE + "/api/expenses", { headers: H2 }).then(x => x.json()); check("הוצאות משותפות נראות לבן/בת הזוג", e4.ok && e4.total >= 200 && e4.shared === true);
  const lv = await fetch(BASE + "/api/household/leave", { method: "POST", headers: H2 }).then(x => x.json()); check("עזיבת הבית", lv.ok && lv.household.exists === false);
  const b2 = await call("GET", "/api/bootstrap"); check("bootstrap כולל בית/רשימות/תורנויות/הוצאות", b2.ok && b2.household && Array.isArray(b2.lists) && Array.isArray(b2.chores) && b2.expenses && b2.expenses.month);
  const pl = await call("POST", "/api/plan", {}); check("תכנון היום (mock)", pl.ok && typeof pl.plan === "string" && pl.date);
  const plg = await call("GET", "/api/plan"); check("תכנון שמור", plg.ok && plg.plan === pl.plan);
  const br2 = await call("POST", "/api/brief", {}); check("תדריך — הוצאות וקניות", br2.ok && br2.expenses && typeof br2.shopping === "number");
  const st = await fetch(BASE + "/api/connect/google", { headers: H, redirect: "manual" }); check("התחלת OAuth: הפניה לגוגל (302) או 503 כשלא מוגדר", st.status === 302 || st.status === 503);
  const bad = await fetch(BASE + "/api/chat", { method: "POST", headers: H, body: "{bad" }).then(x => x.json()); check("JSON שבור → 400", bad.ok === false);
  console.log(fails ? `\n${fails} בדיקות נכשלו` : "\nכל הבדיקות עברו");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
