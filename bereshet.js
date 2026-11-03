/* בראשית (bereshet.timeline-school.com) — קריאה בלבד.
   פעולות מותרות: teacherGrid, dayView, dayViewPublic, ותצוגת grid הציבורית. אין כתיבה.
   הקוד של המורה לעולם לא נרשם ביומן ולא מוחזר ללקוח. */
const BASE = "https://bereshet.timeline-school.com/data/";
const SCHOOL = "beresheet";
const ALLOWED = new Set(["teacherGrid", "dayView", "dayViewPublic"]);
const cache = new Map();   // key → { at, val }
const TTL = { grid: 6 * 3600e3, teacherGrid: 3600e3, day: 5 * 60e3 };

async function post(body) {
  if (!ALLOWED.has(body.action)) throw new Error("action-not-allowed");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ school: SCHOOL }, body)), signal: ctl.signal });
    const j = await r.json().catch(() => ({ ok: false, error: "server" }));
    return j;
  } finally { clearTimeout(t); }
}
async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ttl) return c.val;
  const val = await fn();
  if (val && val.ok) cache.set(key, { at: Date.now(), val });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return val;
}
const hkey = s => require("crypto").createHash("sha256").update(String(s)).digest("hex").slice(0, 16);   // מפתח מטמון בלי הקוד עצמו

async function publicGrid() {
  return cached("grid", TTL.grid, async () => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
    try { const r = await fetch(BASE + "?view=grid&school=" + SCHOOL, { signal: ctl.signal }); return await r.json(); } finally { clearTimeout(t); }
  });
}
async function classes() {
  const g = await publicGrid();
  if (!g || !g.ok) return [];
  return (g.classes || []).map(c => ({ id: c.id, name: c.name, grade: c.grade })).sort((a, b) => a.name.localeCompare(b.name, "he"));
}
async function teacherGrid(code) { return cached("tg:" + hkey(code), TTL.teacherGrid, () => post({ action: "teacherGrid", code })); }

/* אימות קוד: מחזיר { ok, name } או { ok:false, error } בעברית */
async function validateCode(code) {
  let j; try { j = await post({ action: "teacherGrid", code }); } catch (e) { return { ok: false, error: "לא הצלחתי להגיע לבראשית כרגע. נסי שוב בעוד רגע." }; }
  if (!j || !j.ok) {
    const e = String((j && j.error) || "");
    if (/unauthor|forbidden|bad-code|invalid/i.test(e)) return { ok: false, error: "הקוד לא מוכר בבראשית. בדקי שהקלדת את קוד המורה האישי שלך." };
    return { ok: false, error: "בראשית לא אישרה את הקוד (" + e.slice(0, 40) + ")." };
  }
  const me = (j.teachers || []).find(t => t.id === j.me);
  if (!me && !j.admin) return { ok: false, error: "הקוד תקין, אבל בראשית לא מצאה מורה שמתאימה לו (ייתכן שהשם מאוית אחרת)." };
  cache.set("tg:" + hkey(code), { at: Date.now(), val: j });
  return { ok: true, name: me ? me.name : "מנהל/ת" };
}

const dayIdx = date => new Date(date + "T12:00:00Z").getUTCDay();   // 0=ראשון
function bellMap(g) { const m = {}; ((g && g.bell) || []).forEach(b => { m[b.p] = b; }); return m; }
const clsOf = l => [].concat(l.classes || l.class || l.className || l.cls || []).join(", ");

/* src: { kind:'code', code } | { kind:'class', classId, className } */
async function day(src, date) {
  const d = dayIdx(date);
  const g = await publicGrid().catch(() => null);
  const bell = bellMap(g);
  const at = p => bell[p] ? bell[p].start + "–" + bell[p].end : "";
  let lessons = [], who = "";
  let dv;
  if (src.kind === "code") {
    const tg = await teacherGrid(src.code).catch(() => null);
    if (tg && tg.ok) {
      const me = tg.me;
      who = ((tg.teachers || []).find(t => t.id === me) || {}).name || "";
      lessons = (((tg.lessons || {})[me]) || []).filter(l => l.d === d).map(l => ({ p: l.p, time: at(l.p), subject: l.subject || "", room: l.room || "", classes: clsOf(l) }));
    } else if (tg && /unauthor/.test(String(tg.error))) return { ok: false, error: "unauthorized" };
    dv = await cached("dv:" + hkey(src.code) + ":" + date, TTL.day, () => post({ action: "dayView", code: src.code, date })).catch(() => null);
  } else {
    who = src.className || "";
    if (g && g.ok) lessons = (((g.lessons || {})[src.classId]) || []).filter(l => l.d === d).map(l => ({ p: l.p, time: at(l.p), subject: l.subject || "", teacher: l.teacher || "", room: l.room || "" }));
    dv = await cached("dvp:" + src.classId + ":" + date, TTL.day, () => post({ action: "dayViewPublic", date, classId: src.classId })).catch(() => null);
  }
  lessons.sort((a, b) => a.p - b.p);
  const STATE = { away: "הכיתה לא בשיעור", sub: "מילוי מקום", cancel: "בוטל", moved: "הוזז" };
  const changes = dv && dv.ok ? (dv.changes || []).map(c => ({ p: c.p, time: at(c.p), subject: c.subject || "", teacher: c.teacher || "", classes: clsOf(c), room: c.room || "", by: [].concat(c.by || []).map(x => typeof x === "string" ? x : (x && (x.name || x.teacher)) || "").filter(Boolean).join(", "), state: c.state || "", what: STATE[c.state] || c.state || "שינוי" })) : [];
  const away = dv && dv.ok ? (dv.away || []).map(a => ({ class: a.class || "", note: a.note || "", from: a.from, to: a.to })) : [];
  const absent = dv && dv.ok ? [].concat(dv.absent || []).map(a => typeof a === "string" ? a : (a && (a.name || a.teacher || a.note)) || "").filter(Boolean) : [];
  return { ok: true, date, dayName: (dv && dv.dayName) || "", who, lessons, changes, away, absent, special: (dv && dv.special) || "", error: dv && !dv.ok ? String(dv.error || "server") : undefined };
}
function signature(x) { return x && x.ok ? JSON.stringify([x.changes.map(c => [c.p, c.subject, c.state, c.by]), x.away.map(a => [a.class, a.note, a.from, a.to]), x.absent, x.special]) : ""; }
function summary(x) {
  if (!x || !x.ok) return "";
  const parts = [];
  x.changes.forEach(c => parts.push(`שיעור ${c.p}${c.time ? " (" + c.time + ")" : ""} ${c.subject}${c.classes ? " · " + c.classes : ""}: ${c.what}${c.by ? " — " + c.by : ""}`));
  x.away.forEach(a => parts.push(`${a.class}: ${a.note}`));
  if (x.special) parts.push(x.special);
  return parts.join("\n");
}
module.exports = { classes, validateCode, day, signature, summary };
