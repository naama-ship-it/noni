/* ============================================================
   נוני — שרת העוזרת האישית (Noni)
   ------------------------------------------------------------
   עוזרת אישית לכל אחד: אתר (כניסה עם Google) + ווטסאפ. נגזרת מקוד
   Timeline Assist, בלי הקשר לבית ספר. רצה ב-Cloud Run מול Cloud SQL.

   עקרונות
   -------
   1. הרשמה עצמית. כניסה עם חשבון Google (אסימון זהות מאומת בשרת),
      סשן בעוגייה חתומה. אין סיסמאות. ווטסאפ מקושר בקוד חד-פעמי.
   2. שכבת "המומחית". הנחיית המערכת = כללי הפלטפורמה (נעמה) + העדפות
      המשתמש/ת. כל שינוי בכללים מגיע לכולם מיד.
   3. ערוצים. אותה לולאת עוזרת משרתת את האתר ואת ווטסאפ (WhatsApp
      Cloud API של Meta). תזכורות יוצאות בווטסאפ (Cloud Scheduler ←
      /api/cron/reminders).
   4. המודל: vertex (Claude ב-Vertex) · gemini · anthropic (מפתח ישיר) · mock.
   5. שמירה מוגבלת בזמן: שיחות נמחקות אחרי RETENTION_DAYS ימים.

   © כל הזכויות שמורות לנעמה אורפלי
   ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool, types: pgTypes } = require("pg");
pgTypes.setTypeParser(1082, v => v);   // DATE כמחרוזת YYYY-MM-DD — בלי הזזת יום לפי אזור הזמן של השרת
const jose = require("jose");
const crypto = require("crypto");
const ICS = require("./ics");

const VERSION = "2026-11-02-05";
const PORT = Number(process.env.PORT || 8080);
const AUTH_MODE = (process.env.AUTH_MODE || "google").toLowerCase();   // google | none
const SESSION_SECRET = process.env.SESSION_SECRET || "";                     // 32+ תווים — Secret Manager
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.OAUTH_BASE || "").replace(/\/+$/, "");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || "noni";
const ALLOW_AUTO_JOIN = (process.env.ALLOW_AUTO_JOIN || "1") !== "0";   // מורה חדש/ה מהשער מצטרף/ת לבית הספר שבברירת המחדל
const PLATFORM_ADMINS = String(process.env.PLATFORM_ADMINS || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 60);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const MAX_HISTORY = 24;             // הודעות שנשלחות למודל
const MAX_QUESTION = 4000;
const MAX_TOOL_ROUNDS = 6;
const TZ = "Asia/Jerusalem";

const LLM_PROVIDER = (process.env.LLM_PROVIDER || "vertex").toLowerCase();   // vertex | gemini | anthropic | mock
const MODEL = process.env.MODEL || "claude-sonnet-4-6";
/* gemini — מסלול ביניים לסביבת בדיקה בלבד, כשמכסת Claude ב-Vertex עדיין 0:
   Gemini דרך Vertex AI באותו פרויקט, בנקודת הקצה האירופית eu. אותו אסימון שירות, אותם כלים. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_REGION = process.env.GEMINI_REGION || "eu";   // Gemini אינו זמין ב-me-west1; "eu" = נקודת הקצה הרב-אזורית האירופית (4.9.8)
const VERTEX_PROJECT = process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
/* אזור המודל — דרישת 4.9.8 (עיבוד באירופה): ברירת המחדל "eu" = נקודת הקצה הרב-אזורית
   של האיחוד האירופי (aiplatform.eu.rep.googleapis.com). אפשר גם אזור בודד כמו europe-west1
   (מוגבל למודלים עד Sonnet 4.6) או "global" (בלי שמירת מקום — לא לייצור). */
const VERTEX_REGION = process.env.VERTEX_REGION || "eu";
/* ---- שלב 2: חיבורי גוגל (OAuth) ---- */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const OAUTH_BASE = (process.env.OAUTH_BASE || "").replace(/\/+$/, "");          // כתובת השירות, למשל https://timeline-assist-xxxx.me-west1.run.app
const GOOGLE_SCOPES = (process.env.GOOGLE_SCOPES || "calendar").split(/[,\s]+/).filter(Boolean);   // calendar · gmail (ראו README על אימות גוגל)
const CONN_KEY = process.env.CONN_KEY || "";
/* ---- ווטסאפ (WhatsApp Cloud API של Meta) ---- */
const WA_TOKEN = process.env.WA_TOKEN || "";                 // אסימון גישה קבוע של אפליקציית Meta (Secret Manager)
const WA_PHONE_ID = process.env.WA_PHONE_ID || "";           // Phone number ID של המספר של נוני
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "";   // מחרוזת לאימות ה-webhook
const WA_APP_SECRET = process.env.WA_APP_SECRET || "";       // לאימות חתימת הבקשות (X-Hub-Signature-256)
const WA_DISPLAY_NUMBER = process.env.WA_DISPLAY_NUMBER || "";   // המספר להצגה למשתמשים, למשל +972-50-000-0000
const WA_TEMPLATE_REMINDER = process.env.WA_TEMPLATE_REMINDER || "";
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID || "";       // SMS — Twilio (Secret Manager)
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_FROM = process.env.TWILIO_FROM || "";             // +1… / Alphanumeric Sender ID / MG… (Messaging Service)
const smsReady = () => !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM);   // תבנית מאושרת לתזכורת מחוץ לחלון 24 השעות (פרמטר אחד)
const CRON_KEY = process.env.CRON_KEY || "";
const CANON_HOST = (process.env.CANONICAL_HOST || "noni.timeline-school.com").toLowerCase();                 // Cloud Scheduler שולח X-Cron-Key
const SCOPE_URLS = { calendar: "https://www.googleapis.com/auth/calendar.readonly", gmail: "https://www.googleapis.com/auth/gmail.readonly" };
function vertexHost(r) { return r === "global" ? "aiplatform.googleapis.com" : (r === "eu" || r === "us") ? `aiplatform.${r}.rep.googleapis.com` : `${r}-aiplatform.googleapis.com`; }

/* ============================================================
   מסד הנתונים
   ============================================================ */
const pool = new Pool({
  host: process.env.DB_SOCKET || process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || "assist",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "timeline_assist",
  ssl: (process.env.DB_SOCKET || process.env.DB_SSL === "0" || /^(\/|127\.0\.0\.1$|localhost$)/.test(process.env.DB_HOST || "")) ? false : { rejectUnauthorized: false },
  max: 5, idleTimeoutMillis: 30000
});
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8"));
  schemaReady = true;
  cleanupOld().catch(() => {});
}
async function cleanupOld() {
  await pool.query(`DELETE FROM ast_conversation WHERE updated_at < now() - ($1 || ' days')::interval`, [String(RETENTION_DAYS)]);
  await pool.query(`DELETE FROM ast_reminder WHERE status <> 'pending' AND remind_at < now() - interval '30 days'`);
  await pool.query(`DELETE FROM ast_usage WHERE day < current_date - 60`);
}
setInterval(() => cleanupOld().catch(() => {}), 6 * 3600 * 1000).unref();

async function log(tenant, who, action, ref) {
  try { await pool.query(`INSERT INTO ast_log (tenant_id, who, action, ref) VALUES ($1,$2,$3,$4)`, [tenant || "", who || "", action, String(ref || "").slice(0, 300)]); } catch (e) {}
}

/* ============================================================
   כניסה — חשבון Google + סשן בעוגייה חתומה
   ============================================================ */
const COOKIE = "noni_s";
function sessionKey() { if (!SESSION_SECRET) throw new Error("חסר SESSION_SECRET"); return new TextEncoder().encode(SESSION_SECRET); }
function readCookie(req, name) {
  const m = String(req.headers.cookie || "").split(/;\s*/).find(c => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
async function sessionEmail(req) {
  const tok = readCookie(req, COOKIE);
  if (!tok) return "";
  try { const { payload } = await jose.jwtVerify(tok, sessionKey(), { issuer: "noni" }); return String(payload.email || "").toLowerCase(); } catch (e) { return ""; }
}
async function sessionCookie(email) {
  const tok = await new jose.SignJWT({ email }).setProtectedHeader({ alg: "HS256" }).setIssuer("noni").setIssuedAt().setExpirationTime("30d").sign(sessionKey());
  return `${COOKIE}=${encodeURIComponent(tok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}
let oauthClient = null;
async function verifyGoogleIdToken(credential) {
  if (!GOOGLE_CLIENT_ID) throw new Error("חסר GOOGLE_CLIENT_ID");
  const { OAuth2Client } = require("google-auth-library");
  if (!oauthClient) oauthClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  const t = await oauthClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const p = t.getPayload();
  if (!p || !p.email || !p.email_verified) throw new Error("חשבון Google ללא מייל מאומת");
  return { email: String(p.email).toLowerCase(), name: p.name || "", picture: p.picture || "" };
}
async function gateEmail(req) {
  if (AUTH_MODE === "none") return String(req.headers["x-dev-user"] || process.env.DEV_USER || "dev@example.com").toLowerCase();
  return sessionEmail(req);
}

/* ============================================================
   משתמשים ודיירים
   ============================================================ */
async function resolveUser(email, profile) {
  const r = await pool.query(`SELECT u.*, t.name AS tenant_name, t.plan, t.active AS tenant_active
                              FROM ast_user u JOIN ast_tenant t ON t.id=u.tenant_id WHERE u.email=$1 ORDER BY u.id LIMIT 1`, [email]);
  let u = r.rows[0];
  if (!u) {
    if (!ALLOW_AUTO_JOIN && !PLATFORM_ADMINS.includes(email)) return null;
    const t = await pool.query(`SELECT * FROM ast_tenant WHERE id=$1`, [DEFAULT_TENANT]);
    if (!t.rows[0]) return null;
    const role = PLATFORM_ADMINS.includes(email) ? "platform_admin" : "user";
    const name = (profile && profile.name) || email.split("@")[0].replace(/[._-]+/g, " ");
    const ins = await pool.query(`INSERT INTO ast_user (tenant_id, email, display_name, role) VALUES ($1,$2,$3,$4) RETURNING *`, [DEFAULT_TENANT, email, name, role]);
    u = Object.assign(ins.rows[0], { tenant_name: t.rows[0].name, plan: t.rows[0].plan, tenant_active: t.rows[0].active });
    await log(DEFAULT_TENANT, email, "user.join", role);
  }
  if (PLATFORM_ADMINS.includes(email) && u.role !== "platform_admin") {
    await pool.query(`UPDATE ast_user SET role='platform_admin' WHERE id=$1`, [u.id]);
    u.role = "platform_admin";
  }
  pool.query(`UPDATE ast_user SET last_seen_at=now() WHERE id=$1`, [u.id]).catch(() => {});
  return u;
}
const isPlatformAdmin = u => u.role === "platform_admin";
const isSchoolAdmin = u => u.role === "platform_admin";

/* ============================================================
   כלים — זמן, משימות, תזכורות, Timeline
   ============================================================ */
function nowParts() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false });
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
  const dayHe = { Sunday: "ראשון", Monday: "שני", Tuesday: "שלישי", Wednesday: "רביעי", Thursday: "חמישי", Friday: "שישי", Saturday: "שבת" }[p.weekday] || p.weekday;
  return { iso: new Date().toISOString(), date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: dayHe, timezone: TZ };
}
const isoDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const isoTime = v => /^\d{2}:\d{2}(:\d{2})?$/.test(String(v || ""));
const str = (v, n) => String(v == null ? "" : v).slice(0, n || 2000);

function taskOut(r) {
  return { id: r.id, title: r.title, notes: r.notes, dueDate: r.due_date ? fmtDate(r.due_date) : "", dueTime: r.due_time ? String(r.due_time).slice(0, 5) : "", priority: r.priority, status: r.status, createdAt: r.created_at };
}
function fmtDate(d) { return d instanceof Date ? new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(d) : String(d).slice(0, 10); }
function reminderOut(r) { return { id: r.id, text: r.text, remindAt: r.remind_at, status: r.status, channel: r.channel }; }

async function listTasks(u, scope) {
  let where = "user_id=$1";
  if (scope === "open") where += " AND status='open'";
  else if (scope === "today") where += " AND status='open' AND due_date <= $2::date";
  else if (scope === "done") where += " AND status='done'";
  const params = scope === "today" ? [u.id, nowParts().date] : [u.id];
  const r = await pool.query(`SELECT * FROM ast_task WHERE ${where} ORDER BY status, due_date NULLS LAST, due_time NULLS LAST, priority, id DESC LIMIT 200`, params);
  return r.rows.map(taskOut);
}
async function addTask(u, inp, source) {
  const title = str(inp.title, 300).trim();
  if (!title) return { error: "חסרה כותרת למשימה." };
  if (inp.dueDate && !isoDate(inp.dueDate)) return { error: "תאריך לא תקין (YYYY-MM-DD)." };
  if (inp.dueTime && !isoTime(inp.dueTime)) return { error: "שעה לא תקינה (HH:MM)." };
  const pr = [1, 2, 3].includes(Number(inp.priority)) ? Number(inp.priority) : 2;
  const r = await pool.query(`INSERT INTO ast_task (tenant_id,user_id,title,notes,due_date,due_time,priority,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [u.tenant_id, u.id, title, str(inp.notes, 2000), inp.dueDate || null, inp.dueTime || null, pr, source || "chat"]);
  await log(u.tenant_id, u.email, "task.add", r.rows[0].id);
  return { task: taskOut(r.rows[0]) };
}
async function updateTask(u, inp) {
  const id = Number(inp.id);
  if (!id) return { error: "חסר מזהה משימה." };
  const cur = await pool.query(`SELECT * FROM ast_task WHERE id=$1 AND user_id=$2`, [id, u.id]);
  if (!cur.rows[0]) return { error: "המשימה לא נמצאה." };
  const c = cur.rows[0];
  const status = ["open", "done", "dropped"].includes(inp.status) ? inp.status : c.status;
  if (inp.dueDate && !isoDate(inp.dueDate)) return { error: "תאריך לא תקין (YYYY-MM-DD)." };
  if (inp.dueTime && !isoTime(inp.dueTime)) return { error: "שעה לא תקינה (HH:MM)." };
  const r = await pool.query(`UPDATE ast_task SET title=$3, notes=$4, due_date=$5, due_time=$6, priority=$7, status=$8,
      done_at = CASE WHEN $8='done' AND status<>'done' THEN now() WHEN $8<>'done' THEN NULL ELSE done_at END, updated_at=now()
      WHERE id=$1 AND user_id=$2 RETURNING *`,
    [id, u.id, inp.title != null ? str(inp.title, 300) : c.title, inp.notes != null ? str(inp.notes, 2000) : c.notes,
     inp.dueDate === "" ? null : (inp.dueDate || c.due_date), inp.dueTime === "" ? null : (inp.dueTime || c.due_time),
     [1, 2, 3].includes(Number(inp.priority)) ? Number(inp.priority) : c.priority, status]);
  await log(u.tenant_id, u.email, "task.update", id + ":" + status);
  return { task: taskOut(r.rows[0]) };
}
async function listReminders(u, all) {
  const r = await pool.query(`SELECT * FROM ast_reminder WHERE user_id=$1 ${all ? "" : "AND status='pending'"} ORDER BY remind_at LIMIT 100`, [u.id]);
  return r.rows.map(reminderOut);
}
async function addReminder(u, inp) {
  const text = str(inp.text, 500).trim();
  if (!text) return { error: "חסר טקסט לתזכורת." };
  const when = inp.remindAt ? new Date(inp.remindAt) : null;
  if (!when || isNaN(when)) return { error: "חסר מועד לתזכורת (ISO 8601, למשל 2026-11-02T07:30:00+02:00)." };
  if (when.getTime() < Date.now() - 60e3) return { error: "המועד של התזכורת כבר עבר — צריך מועד עתידי." };
  const r = await pool.query(`INSERT INTO ast_reminder (tenant_id,user_id,text,remind_at) VALUES ($1,$2,$3,$4) RETURNING *`, [u.tenant_id, u.id, text, when.toISOString()]);
  await log(u.tenant_id, u.email, "reminder.add", r.rows[0].id);
  return { reminder: reminderOut(r.rows[0]) };
}
async function cancelReminder(u, id) {
  const r = await pool.query(`UPDATE ast_reminder SET status='cancelled' WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *`, [Number(id) || 0, u.id]);
  return r.rows[0] ? { reminder: reminderOut(r.rows[0]) } : { error: "התזכורת לא נמצאה." };
}
async function dueReminders(u) {
  const r = await pool.query(`UPDATE ast_reminder SET status='shown' WHERE user_id=$1 AND status='pending' AND remind_at <= now() RETURNING *`, [u.id]);
  return r.rows.map(reminderOut);
}

/* ============================================================
   משק בית — רשימות משותפות, תורנויות, הוצאות
   משק בית נוצר לבד בפעם הראשונה שצריך אותו; בני בית מצטרפים בקוד הזמנה.
   ============================================================ */
const EXPENSE_CATS = ["מזון", "בית", "ילדים", "רכב", "בריאות", "פנאי", "ביגוד", "חשבונות", "אחר"];
function inviteCode() { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += a[crypto.randomInt(a.length)]; return s; }
async function household(u, create) {
  if (u.household_id) { const r = await pool.query(`SELECT * FROM noni_household WHERE id=$1`, [u.household_id]); if (r.rows[0]) return r.rows[0]; }
  if (!create) return null;
  const r = await pool.query(`INSERT INTO noni_household (name, invite_code, created_by) VALUES ('הבית שלי',$1,$2) RETURNING *`, [inviteCode(), u.id]);
  await pool.query(`UPDATE ast_user SET household_id=$2 WHERE id=$1`, [u.id, r.rows[0].id]);
  u.household_id = r.rows[0].id;
  await log(u.tenant_id, u.email, "household.create", r.rows[0].id);
  return r.rows[0];
}
async function householdOut(u) {
  const h = await household(u, false);
  if (!h) return { exists: false, members: [], name: "", code: "" };
  const m = await pool.query(`SELECT display_name, email FROM ast_user WHERE household_id=$1 ORDER BY id`, [h.id]);
  return { exists: true, id: h.id, name: h.name, code: h.invite_code, members: m.rows.map(x => ({ name: x.display_name, email: x.email, me: x.email === u.email })) };
}
async function householdJoin(u, code) {
  const c = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const r = await pool.query(`SELECT * FROM noni_household WHERE invite_code=$1`, [c]);
  if (!r.rows[0]) return { error: "קוד הזמנה לא נמצא." };
  const h = r.rows[0];
  if (u.household_id === h.id) return { error: "את/ה כבר בבית הזה." };
  const old = u.household_id;
  await pool.query(`UPDATE ast_user SET household_id=$2 WHERE id=$1`, [u.id, h.id]);
  if (old) {   // אם נשארתי לבד בבית הישן — הרשימות וההוצאות עוברות איתי
    const left = await pool.query(`SELECT count(*)::int AS n FROM ast_user WHERE household_id=$1`, [old]);
    if (left.rows[0].n === 0) {
      await pool.query(`UPDATE noni_list SET household_id=$2 WHERE household_id=$1 AND name NOT IN (SELECT name FROM noni_list WHERE household_id=$2)`, [old, h.id]);
      await pool.query(`UPDATE noni_chore SET household_id=$2 WHERE household_id=$1`, [old, h.id]);
      await pool.query(`UPDATE noni_expense SET household_id=$2 WHERE household_id=$1`, [old, h.id]);
      await pool.query(`DELETE FROM noni_household WHERE id=$1`, [old]);
    }
  }
  u.household_id = h.id;
  await log(u.tenant_id, u.email, "household.join", h.id);
  return { household: await householdOut(u) };
}
async function householdLeave(u) {
  if (!u.household_id) return { household: await householdOut(u) };
  const old = u.household_id;
  await pool.query(`UPDATE ast_user SET household_id=NULL WHERE id=$1`, [u.id]);
  u.household_id = null;
  const left = await pool.query(`SELECT count(*)::int AS n FROM ast_user WHERE household_id=$1`, [old]);
  if (left.rows[0].n === 0) await pool.query(`DELETE FROM noni_household WHERE id=$1`, [old]);
  await log(u.tenant_id, u.email, "household.leave", old);
  return { household: await householdOut(u) };
}
async function householdRename(u, name) {
  const h = await household(u, true);
  await pool.query(`UPDATE noni_household SET name=$2 WHERE id=$1`, [h.id, str(name, 60).trim() || "הבית שלי"]);
  return { household: await householdOut(u) };
}

/* ---- רשימות ---- */
const DEFAULT_LIST = "קניות";
async function getList(u, name, create) {
  const h = await household(u, create);
  if (!h) return null;
  const nm = str(name, 60).trim() || DEFAULT_LIST;
  const r = await pool.query(`SELECT * FROM noni_list WHERE household_id=$1 AND name=$2`, [h.id, nm]);
  if (r.rows[0]) return r.rows[0];
  if (!create) { if (nm !== DEFAULT_LIST) return null; }
  const ins = await pool.query(`INSERT INTO noni_list (household_id, name, kind) VALUES ($1,$2,$3) RETURNING *`, [h.id, nm, nm === DEFAULT_LIST ? "shopping" : "list"]);
  return ins.rows[0];
}
async function listsOut(u) {
  const h = await household(u, false);
  if (!h) return [];
  const ls = await pool.query(`SELECT * FROM noni_list WHERE household_id=$1 ORDER BY kind DESC, id`, [h.id]);
  const items = await pool.query(`SELECT i.* FROM noni_list_item i JOIN noni_list l ON l.id=i.list_id WHERE l.household_id=$1 ORDER BY i.done, i.id`, [h.id]);
  return ls.rows.map(l => ({ id: l.id, name: l.name, kind: l.kind, shareUrl: l.share_token ? (PUBLIC_URL || "") + "/l/" + l.share_token : "", items: items.rows.filter(i => i.list_id === l.id).map(i => ({ id: i.id, text: i.text, qty: i.qty, done: i.done, by: i.added_by })) }));
}
async function listOne(u, name) {
  const l = await getList(u, name, false);
  if (!l) return { list: name || DEFAULT_LIST, items: [], note: "הרשימה ריקה." };
  const r = await pool.query(`SELECT * FROM noni_list_item WHERE list_id=$1 ORDER BY done, id`, [l.id]);
  return { list: l.name, items: r.rows.map(i => ({ id: i.id, text: i.text, qty: i.qty, done: i.done, by: i.added_by })) };
}
async function addListItems(u, inp, source) {
  const raw = Array.isArray(inp.items) ? inp.items : String(inp.items || inp.text || "").split(/[,\n،]+/);
  const items = raw.map(x => typeof x === "string" ? { text: x } : (x || {})).map(x => ({ text: str(x.text, 120).trim(), qty: str(x.qty, 20).trim() })).filter(x => x.text);
  if (!items.length) return { error: "אין פריטים להוספה." };
  const l = await getList(u, inp.list, true);
  const existing = await pool.query(`SELECT lower(text) AS t FROM noni_list_item WHERE list_id=$1 AND NOT done`, [l.id]);
  const have = new Set(existing.rows.map(r => r.t));
  let added = 0;
  for (const it of items) {
    if (have.has(it.text.toLowerCase())) continue;
    await pool.query(`INSERT INTO noni_list_item (list_id, text, qty, added_by) VALUES ($1,$2,$3,$4)`, [l.id, it.text, it.qty, u.display_name || ""]);
    have.add(it.text.toLowerCase()); added++;
  }
  await log(u.tenant_id, u.email, "list.add", l.name + ":" + added + ":" + (source || "chat"));
  return Object.assign({ added, skipped: items.length - added }, await listOne(u, l.name));
}
async function checkListItems(u, inp) {
  const l = await getList(u, inp.list, false);
  if (!l) return { error: "הרשימה לא נמצאה." };
  const done = inp.done !== false;
  let n = 0;
  if (Array.isArray(inp.ids) && inp.ids.length) { const r = await pool.query(`UPDATE noni_list_item SET done=$3, done_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE list_id=$1 AND id = ANY($2::bigint[])`, [l.id, inp.ids.map(Number).filter(Boolean), done]); n += r.rowCount; }
  const texts = Array.isArray(inp.texts) ? inp.texts : inp.text ? [inp.text] : [];
  for (const t of texts) { const r = await pool.query(`UPDATE noni_list_item SET done=$3, done_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE list_id=$1 AND lower(text) LIKE lower($2)`, [l.id, "%" + str(t, 120).trim() + "%", done]); n += r.rowCount; }
  if (inp.all) { const r = await pool.query(`UPDATE noni_list_item SET done=$2, done_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE list_id=$1`, [l.id, done]); n += r.rowCount; }
  return Object.assign({ updated: n }, await listOne(u, l.name));
}
async function clearDoneItems(u, name) {
  const l = await getList(u, name, false);
  if (!l) return { error: "הרשימה לא נמצאה." };
  const r = await pool.query(`DELETE FROM noni_list_item WHERE list_id=$1 AND done`, [l.id]);
  return Object.assign({ removed: r.rowCount }, await listOne(u, l.name));
}
async function deleteList(u, name) {
  const l = await getList(u, name, false);
  if (!l) return { error: "הרשימה לא נמצאה." };
  await pool.query(`DELETE FROM noni_list WHERE id=$1`, [l.id]);
  return { ok: true, lists: await listsOut(u) };
}

/* ---- שיתוף רשימה בקישור ---- */
async function listShare(u, name, revoke) {
  const l = await getList(u, name, true);
  if (revoke) { await pool.query(`UPDATE noni_list SET share_token=NULL WHERE id=$1`, [l.id]); return { url: "" }; }
  let tok = l.share_token;
  if (!tok) { tok = crypto.randomBytes(12).toString("base64url"); await pool.query(`UPDATE noni_list SET share_token=$2 WHERE id=$1`, [l.id, tok]); await log(u.tenant_id, u.email, "list.share", l.name); }
  return { url: (PUBLIC_URL || "") + "/l/" + tok, token: tok, list: l.name };
}
async function sharedList(token) {
  const t = String(token || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  if (!t) return null;
  const r = await pool.query(`SELECT l.*, h.name AS household FROM noni_list l JOIN noni_household h ON h.id=l.household_id WHERE l.share_token=$1`, [t]);
  return r.rows[0] || null;
}
async function sharedListOut(l) {
  const r = await pool.query(`SELECT * FROM noni_list_item WHERE list_id=$1 ORDER BY done, id`, [l.id]);
  return { list: l.name, household: l.household, items: r.rows.map(i => ({ id: i.id, text: i.text, qty: i.qty, done: i.done, by: i.added_by })) };
}

/* ---- תורנויות ---- */
function choreOut(c) { const who = c.people[c.turn_idx % Math.max(1, c.people.length)] || ""; return { id: c.id, title: c.title, people: c.people, turn: who, cadence: c.cadence, nextDate: c.next_date ? fmtDate(c.next_date) : "", lastDoneBy: c.last_done_by, lastDoneAt: c.last_done_at }; }
async function listChores(u) {
  const h = await household(u, false);
  if (!h) return [];
  const r = await pool.query(`SELECT * FROM noni_chore WHERE household_id=$1 ORDER BY next_date NULLS LAST, id`, [h.id]);
  return r.rows.map(choreOut);
}
async function addChore(u, inp) {
  const title = str(inp.title, 120).trim();
  if (!title) return { error: "חסר שם לתורנות." };
  const people = (Array.isArray(inp.people) ? inp.people : String(inp.people || "").split(/[,،]+/)).map(p => str(p, 40).trim()).filter(Boolean);
  if (!people.length) people.push(u.display_name || "אני");
  const cadence = ["daily", "weekly", "once"].includes(inp.cadence) ? inp.cadence : "weekly";
  const next = inp.nextDate && isoDate(inp.nextDate) ? inp.nextDate : nowParts().date;
  const h = await household(u, true);
  const r = await pool.query(`INSERT INTO noni_chore (household_id, title, people, cadence, next_date) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [h.id, title, people, cadence, next]);
  await log(u.tenant_id, u.email, "chore.add", r.rows[0].id);
  return { chore: choreOut(r.rows[0]), chores: await listChores(u) };
}
async function choreDone(u, inp) {
  const h = await household(u, false);
  if (!h) return { error: "אין תורנויות עדיין." };
  let r;
  if (inp.id) r = await pool.query(`SELECT * FROM noni_chore WHERE household_id=$1 AND id=$2`, [h.id, Number(inp.id)]);
  else r = await pool.query(`SELECT * FROM noni_chore WHERE household_id=$1 AND lower(title) LIKE lower($2) ORDER BY id LIMIT 1`, [h.id, "%" + str(inp.title, 120).trim() + "%"]);
  const c = r.rows[0];
  if (!c) return { error: "התורנות לא נמצאה." };
  const by = str(inp.by, 40).trim() || c.people[c.turn_idx % Math.max(1, c.people.length)] || u.display_name;
  if (c.cadence === "once") { await pool.query(`DELETE FROM noni_chore WHERE id=$1`, [c.id]); return { done: true, title: c.title, by, chores: await listChores(u) }; }
  const nextIdx = (c.turn_idx + 1) % Math.max(1, c.people.length);
  const base = c.next_date ? new Date(fmtDate(c.next_date) + "T12:00:00Z") : new Date();
  base.setUTCDate(base.getUTCDate() + (c.cadence === "daily" ? 1 : 7));
  const up = await pool.query(`UPDATE noni_chore SET turn_idx=$2, next_date=$3, last_done_by=$4, last_done_at=now() WHERE id=$1 RETURNING *`, [c.id, nextIdx, base.toISOString().slice(0, 10), by]);
  return { done: true, chore: choreOut(up.rows[0]), chores: await listChores(u) };
}
async function deleteChore(u, id) {
  const h = await household(u, false);
  if (!h) return { error: "לא נמצא." };
  await pool.query(`DELETE FROM noni_chore WHERE household_id=$1 AND id=$2`, [h.id, Number(id) || 0]);
  return { chores: await listChores(u) };
}

/* ---- הוצאות ---- */
function expenseOut(e) { return { id: e.id, amount: Number(e.amount), currency: e.currency, category: e.category, note: e.note, date: fmtDate(e.spent_on), by: e.added_by, source: e.source }; }
function normCategory(c) { c = str(c, 30).trim(); if (!c) return "אחר"; const hit = EXPENSE_CATS.find(x => c.includes(x)); if (hit) return hit; if (/סופר|אוכל|מסעדה|קפה|מכולת|ירקות/.test(c)) return "מזון"; if (/דלק|רכב|חניה|חנייה|מוסך/.test(c)) return "רכב"; if (/תרופ|רופא|קופ"ח|מרפאה/.test(c)) return "בריאות"; if (/חוג|גן|בית ספר|צעצוע/.test(c)) return "ילדים"; if (/חשמל|מים|ארנונה|גז|אינטרנט|סלולר/.test(c)) return "חשבונות"; if (/בגד|נעל/.test(c)) return "ביגוד"; if (/סרט|הופעה|טיול|מלון|בילוי/.test(c)) return "פנאי"; return c; }
async function addExpense(u, inp, source) {
  if (/^\s*-/.test(String(inp.amount || ""))) return { error: "הסכום צריך להיות חיובי." };
  const amount = Number(String(inp.amount || "").replace(/[^\d.]/g, ""));
  if (!amount || amount <= 0 || amount > 1e7) return { error: "חסר סכום תקין." };
  const date = inp.date && isoDate(inp.date) ? inp.date : nowParts().date;
  const r = await pool.query(`INSERT INTO noni_expense (user_id, household_id, amount, currency, category, note, spent_on, source, added_by) VALUES ($1,$2,$3,'ILS',$4,$5,$6,$7,$8) RETURNING *`,
    [u.id, u.household_id || null, amount, normCategory(inp.category || inp.note), str(inp.note, 200).trim(), date, source || "chat", u.display_name || ""]);
  await log(u.tenant_id, u.email, "expense.add", r.rows[0].id);
  return { expense: expenseOut(r.rows[0]) };
}
async function deleteExpense(u, id) {
  await pool.query(`DELETE FROM noni_expense WHERE id=$1 AND (user_id=$2 OR (household_id IS NOT NULL AND household_id=$3))`, [Number(id) || 0, u.id, u.household_id || 0]);
  return { ok: true };
}
function expenseWhere(u) { return u.household_id ? { sql: "(e.user_id=$1 OR e.household_id=$2)", params: [u.id, u.household_id] } : { sql: "e.user_id=$1", params: [u.id] }; }
async function listExpenses(u, inp) {
  const n = nowParts().date;
  const from = inp.fromDate && isoDate(inp.fromDate) ? inp.fromDate : n.slice(0, 8) + "01";
  const to = inp.toDate && isoDate(inp.toDate) ? inp.toDate : n;
  const w = expenseWhere(u);
  const r = await pool.query(`SELECT e.* FROM noni_expense e WHERE ${w.sql} AND e.spent_on BETWEEN $${w.params.length + 1} AND $${w.params.length + 2} ORDER BY e.spent_on DESC, e.id DESC LIMIT 300`, [...w.params, from, to]);
  const byCat = {};
  let total = 0;
  for (const e of r.rows) { const a = Number(e.amount); total += a; byCat[e.category] = (byCat[e.category] || 0) + a; }
  return { from, to, total: Math.round(total * 100) / 100, byCategory: Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 })), expenses: r.rows.map(expenseOut), shared: !!u.household_id };
}
async function expenseSummary(u) {
  const n = nowParts().date;
  const d = new Date(n + "T12:00:00Z"); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - dow);   // תחילת השבוע (ראשון)
  const weekFrom = d.toISOString().slice(0, 10);
  const month = await listExpenses(u, { fromDate: n.slice(0, 8) + "01", toDate: n });
  const week = await listExpenses(u, { fromDate: weekFrom, toDate: n });
  const prev = new Date(n.slice(0, 8) + "01T12:00:00Z"); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const pm = prev.toISOString().slice(0, 7);
  const last = await listExpenses(u, { fromDate: pm + "-01", toDate: new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) });
  return { month: { from: month.from, total: month.total, byCategory: month.byCategory }, week: { from: weekFrom, total: week.total }, lastMonth: { month: pm, total: last.total }, recent: month.expenses.slice(0, 8) };
}


/* ============================================================
   שלב 2 — חיבורי גוגל: הצפנה, OAuth, רענון אסימון, יומן ומייל
   ============================================================ */
function connKey() {
  if (!CONN_KEY) throw new Error("חסר CONN_KEY (מפתח הצפנה לחיבורים)");
  const k = Buffer.from(CONN_KEY, "base64");
  if (k.length !== 32) throw new Error("CONN_KEY חייב להיות 32 בתים ב-base64");
  return k;
}
function encrypt(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", connKey(), iv);
  const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function decrypt(b64) {
  const b = Buffer.from(b64, "base64"), iv = b.subarray(0, 12), tag = b.subarray(12, 28), enc = b.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", connKey(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}
const googleReady = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && OAUTH_BASE && CONN_KEY);

async function getConnection(u, provider) {
  const r = await pool.query(`SELECT * FROM ast_connection WHERE user_id=$1 AND provider=$2`, [u.id, provider || "google"]);
  return r.rows[0] || null;
}
async function connectionsOut(u) {
  const r = await pool.query(`SELECT provider, account_email, scopes, status, last_error, updated_at FROM ast_connection WHERE user_id=$1`, [u.id]);
  const g = r.rows.find(x => x.provider === "google");
  const granted = GOOGLE_SCOPES.filter(sc => g && new RegExp(sc === "gmail" ? "gmail" : "calendar").test(g.scopes || ""));
  const ic = r.rows.find(x => x.provider === "ics");
  return { sms: await smsOut(u), ics: { available: !!CONN_KEY, connected: !!ic, label: ic ? ic.account_email : "", error: ic ? ic.last_error : "", since: ic ? ic.updated_at : null },
    google: { available: googleReady(), scopes: GOOGLE_SCOPES, granted, connected: !!g && g.status === "active", email: g ? g.account_email : "", status: g ? g.status : "none", error: g ? g.last_error : "", since: g ? g.updated_at : null } };
}
async function googleAccessToken(u) {
  const c = await getConnection(u, "google");
  if (!c || c.status !== "active") return { error: "not-connected" };
  if (c.access_token && c.expires_at && new Date(c.expires_at) - Date.now() > 60000) return { token: c.access_token, conn: c };
  let refresh;
  try { refresh = decrypt(c.refresh_enc); } catch (e) { return { error: "decrypt" }; }
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const err = (j.error || "refresh-failed") + (j.error_description ? ": " + j.error_description : "");
    await pool.query(`UPDATE ast_connection SET status=$3, last_error=$4, updated_at=now() WHERE user_id=$1 AND provider=$2`, [u.id, "google", j.error === "invalid_grant" ? "revoked" : "error", err.slice(0, 300)]);
    return { error: err };
  }
  const exp = new Date(Date.now() + (Number(j.expires_in || 3600) - 30) * 1000).toISOString();
  await pool.query(`UPDATE ast_connection SET access_token=$3, expires_at=$4, last_error='', updated_at=now() WHERE user_id=$1 AND provider=$2`, [u.id, "google", j.access_token, exp]);
  return { token: j.access_token, conn: c };
}
async function gapi(u, url, query) {
  const t = await googleAccessToken(u);
  if (t.error) return { error: t.error === "not-connected" ? "needs-google" : "החיבור לגוגל נכשל (" + t.error + "). כדאי לחבר מחדש בהגדרות ← חיבורים." };
  const full = url + (query ? "?" + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== "")).toString() : "");
  const res = await fetch(full, { headers: { Authorization: "Bearer " + t.token } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) return { error: "גוגל החזיר שגיאה " + res.status + ": " + String(j.error && j.error.message || "").slice(0, 200) };
  return j;
}
const NEEDS_GOOGLE = { error: "needs-google", message: "כדי לענות על היומן או המייל צריך קודם לחבר את חשבון גוגל: הגדרות ← חיבורים ← חיבור גוגל." };

async function toolCalendar(u, inp) {
  const from = inp.fromDate && isoDate(inp.fromDate) ? inp.fromDate : nowParts().date;
  const to = inp.toDate && isoDate(inp.toDate) ? inp.toDate : from;
  const gc = await getConnection(u, "google");
  const ic = await getConnection(u, "ics");
  const hasG = gc && gc.status === "active" && GOOGLE_SCOPES.includes("calendar");
  if (!hasG && !ic) return googleCalendar(u, inp);   // ההתנהגות הקיימת (needs-google)
  let events = [], errors = [];
  if (hasG) { const g = await googleCalendar(u, { fromDate: from, toDate: to }); if (g.error) errors.push(g.message || g.error); else events.push(...g.events.map(e => Object.assign(e, { source: "google" }))); }
  if (ic) { const i = await icsEvents(u, ic, from, to); if (i.error) errors.push(i.error); else events.push(...i.events); }
  events.sort((a, b) => (a._t || 0) - (b._t || 0));
  events.forEach(e => delete e._t);
  if (!events.length && errors.length) return { error: errors.join(" · ") };
  return { from, to, events, warnings: errors.length ? errors : undefined };
}
/* ---- יומן ICS (אפל / כל יומן) — קישור מנוי, מוצפן במסד, קריאה בלבד ---- */
const icsCache = new Map();   // user_id → { at, url, events }
function normIcsUrl(s) {
  s = String(s || "").trim().replace(/^webcals?:\/\//i, "https://");
  let u; try { u = new URL(s); } catch (e) { return ""; }
  if (!/^https?:$/.test(u.protocol)) return "";
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|metadata)/i.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return "";
  return u.toString();
}
async function fetchIcs(url) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", headers: { "User-Agent": "Noni-Calendar/1.0", Accept: "text/calendar,*/*" } });
    if (!r.ok) throw new Error("היומן החזיר שגיאה " + r.status);
    const txt = (await r.text()).slice(0, 5e6);
    if (!/BEGIN:VCALENDAR/i.test(txt)) throw new Error("הקישור לא מחזיר יומן ICS");
    return ICS.parseICS(txt, TZ);
  } finally { clearTimeout(t); }
}
async function icsEvents(u, conn, from, to) {
  try {
    let c = icsCache.get(u.id);
    if (!c || Date.now() - c.at > 10 * 60000 || c.v !== conn.updated_at + "") {
      const url = decrypt(conn.refresh_enc);
      c = { at: Date.now(), v: conn.updated_at + "", events: await fetchIcs(url) };
      icsCache.set(u.id, c);
      if (conn.last_error) await pool.query(`UPDATE ast_connection SET last_error='' WHERE id=$1`, [conn.id]);
    }
    const a = ICS.wallToUtc(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10), 0, 0, 0, TZ);
    const b = ICS.wallToUtc(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10) + 1, 0, 0, 0, TZ);
    const fmt = ms => new Date(ms).toLocaleString("he-IL", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
    const fmtD = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date(ms + 12 * 3600e3));
    return { events: ICS.eventsBetween(c.events, a, b).slice(0, 80).map(e => ({ id: "ics:" + e.uid, title: e.title, start: e.allDay ? fmtD(e.startMs) + " (כל היום)" : fmt(e.startMs), end: e.allDay ? "" : fmt(e.endMs), location: e.location, allDay: e.allDay, link: "", source: "ics", _t: e.startMs })) };
  } catch (e) {
    const msg = "יומן ICS: " + String(e.name === "AbortError" ? "הזמן לטעינה עבר" : (e.message || e)).slice(0, 120);
    await pool.query(`UPDATE ast_connection SET last_error=$2 WHERE id=$1`, [conn.id, msg]).catch(() => {});
    return { error: msg };
  }
}
async function googleCalendar(u, inp) {
  if (!GOOGLE_SCOPES.includes("calendar")) return { error: "חיבור היומן אינו מופעל בפלטפורמה." };
  const from = inp.fromDate && isoDate(inp.fromDate) ? inp.fromDate : nowParts().date;
  const to = inp.toDate && isoDate(inp.toDate) ? inp.toDate : from;
  const timeMin = new Date(from + "T00:00:00+02:00"), timeMax = new Date(to + "T23:59:59+02:00");
  const j = await gapi(u, "https://www.googleapis.com/calendar/v3/calendars/primary/events", { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: 50, timeZone: TZ });
  if (j.error) return j.error === "needs-google" ? NEEDS_GOOGLE : { error: j.error };
  const fmt = d => d ? new Date(d).toLocaleString("he-IL", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
  return { from, to, events: (j.items || []).map(e => ({ _t: Date.parse(e.start && (e.start.dateTime || e.start.date + "T00:00:00+02:00")) || 0, id: e.id, title: e.summary || "(ללא כותרת)", start: e.start && (e.start.dateTime ? fmt(e.start.dateTime) : e.start.date + " (כל היום)"), end: e.end && (e.end.dateTime ? fmt(e.end.dateTime) : ""), location: e.location || "", allDay: !!(e.start && e.start.date), link: e.htmlLink || "" })) };
}
async function toolSearchEmail(u, inp) {
  if (!GOOGLE_SCOPES.includes("gmail")) return { error: "חיבור המייל אינו מופעל בפלטפורמה בשלב זה." };
  const j = await gapi(u, "https://gmail.googleapis.com/gmail/v1/users/me/messages", { q: str(inp.query, 300) || "newer_than:2d", maxResults: Math.min(Number(inp.max) || 8, 15) });
  if (j.error) return j.error === "needs-google" ? NEEDS_GOOGLE : { error: j.error };
  const out = [];
  for (const m of (j.messages || [])) {
    const d = await gapi(u, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`, { format: "metadata", metadataHeaders: "Subject" });
    if (d.error) break;
    const h = Object.fromEntries((d.payload && d.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
    out.push({ id: m.id, subject: h.subject || "(ללא נושא)", from: h.from || "", date: h.date || "", snippet: d.snippet || "", unread: (d.labelIds || []).includes("UNREAD") });
  }
  return { query: inp.query || "newer_than:2d", messages: out };
}
async function toolReadEmail(u, inp) {
  if (!GOOGLE_SCOPES.includes("gmail")) return { error: "חיבור המייל אינו מופעל בפלטפורמה בשלב זה." };
  const d = await gapi(u, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(str(inp.id, 64))}`, { format: "full" });
  if (d.error) return d.error === "needs-google" ? NEEDS_GOOGLE : { error: d.error };
  const h = Object.fromEntries((d.payload && d.payload.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  let body = "";
  const walk = p => { if (!p) return; if (p.mimeType === "text/plain" && p.body && p.body.data) body += Buffer.from(p.body.data, "base64url").toString("utf8"); (p.parts || []).forEach(walk); };
  walk(d.payload);
  if (!body && d.payload && d.payload.body && d.payload.body.data) body = Buffer.from(d.payload.body.data, "base64url").toString("utf8").replace(/<[^>]+>/g, " ");
  return { subject: h.subject || "", from: h.from || "", to: h.to || "", date: h.date || "", body: body.replace(/\s+\n/g, "\n").slice(0, 6000) || d.snippet || "" };
}

/* ---- מיילים חשובים לתדריך: לא נקראו, לא פרסומות/רשתות, מהיומיים האחרונים ---- */
async function importantMail(u) {
  const gc = await getConnection(u, "google");
  if (!gc || gc.status !== "active" || !GOOGLE_SCOPES.includes("gmail")) return null;
  if (!/gmail/.test(gc.scopes || "")) return { error: "needs-gmail-scope" };
  const r = await toolSearchEmail(u, { query: "is:unread newer_than:2d -category:promotions -category:social -category:forums", max: 8 });
  if (r.error) return { error: r.message || r.error };
  return r.messages;
}
/* ---- תכנון היום: הנתונים שהמודל צריך כדי להציע לוח זמנים ---- */
async function planData(u, date) {
  const n = nowParts();
  const day = date && isoDate(date) ? date : n.date;
  const tasks = (await listTasks(u, "open")).filter(t => !t.dueDate || t.dueDate <= day).slice(0, 25);
  const reminders = (await listReminders(u, false)).filter(r => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(r.remindAt)) === day);
  let calendar = null;
  const gc = await getConnection(u, "google");
  if ((gc && gc.status === "active" && GOOGLE_SCOPES.includes("calendar")) || await getConnection(u, "ics")) { const c = await toolCalendar(u, { fromDate: day, toDate: day }); calendar = c.error ? { error: c.message || c.error } : c.events; }
  const chores = (await listChores(u)).filter(c => c.nextDate && c.nextDate <= day);
  return { date: day, now: day === n.date ? n.time : "", weekday: n.weekday, calendar, tasks, reminders, chores, guidance: "הצע/י לוח זמנים לפי שעות: קודם אירועי היומן (קבועים), ואז המשימות לפי עדיפות ומועד, עם הפסקות. אם אין מספיק זמן — אמור/י מה לדחות למחר. קצר, בעברית, בלי כותרות." };
}

/* OAuth: התחלה — יצירת state והפניה לגוגל */
async function oauthStart(u, res) {
  if (!googleReady()) return json(res, 503, { ok: false, error: "חיבור גוגל עדיין לא הוגדר בשרת (מזהה לקוח / סוד / CONN_KEY / OAUTH_BASE)." });
  const state = crypto.randomBytes(24).toString("base64url");
  await pool.query(`DELETE FROM ast_oauth_state WHERE created_at < now() - interval '15 minutes'`);
  await pool.query(`INSERT INTO ast_oauth_state (state, user_id, provider) VALUES ($1,$2,'google')`, [state, u.id]);
  const scopes = ["openid", "email", ...GOOGLE_SCOPES.map(s => SCOPE_URLS[s]).filter(Boolean)].join(" ");
  const q = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: OAUTH_BASE + "/api/connect/google/callback", response_type: "code", scope: scopes, access_type: "offline", prompt: "consent", include_granted_scopes: "true", state, login_hint: u.email });
  res.writeHead(302, { Location: "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString(), "Cache-Control": "no-store" }); res.end();
}
/* OAuth: חזרה מגוגל — החלפת הקוד באסימונים ושמירה מוצפנת */
async function oauthCallback(u, url, res) {
  const back = (msg) => { res.writeHead(302, { Location: "/#settings" + (msg ? "?conn=" + encodeURIComponent(msg) : ""), "Cache-Control": "no-store" }); res.end(); };
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  if (url.searchParams.get("error")) return back("בוטל: " + url.searchParams.get("error"));
  const st = await pool.query(`DELETE FROM ast_oauth_state WHERE state=$1 AND user_id=$2 AND created_at > now() - interval '15 minutes' RETURNING provider`, [state, u.id]);
  if (!st.rows[0] || !code) return back("החיבור לא אומת (state). נסו שוב.");
  const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: OAUTH_BASE + "/api/connect/google/callback", grant_type: "authorization_code" }) });
  const t = await tr.json().catch(() => ({}));
  if (!tr.ok || !t.refresh_token) { await log(u.tenant_id, u.email, "connect.google.fail", t.error || tr.status); return back("גוגל לא החזיר אסימון" + (t.error ? " (" + t.error + ")" : "") + ". נסו שוב."); }
  let acct = "";
  try { const ui = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + t.access_token } }); acct = (await ui.json()).email || ""; } catch (e) {}
  const exp = new Date(Date.now() + (Number(t.expires_in || 3600) - 30) * 1000).toISOString();
  await pool.query(`INSERT INTO ast_connection (tenant_id,user_id,provider,account_email,scopes,refresh_enc,access_token,expires_at,status)
    VALUES ($1,$2,'google',$3,$4,$5,$6,$7,'active')
    ON CONFLICT (user_id,provider) DO UPDATE SET account_email=$3, scopes=$4, refresh_enc=$5, access_token=$6, expires_at=$7, status='active', last_error='', updated_at=now()`,
    [u.tenant_id, u.id, acct, t.scope || "", encrypt(t.refresh_token), t.access_token || "", exp]);
  await log(u.tenant_id, u.email, "connect.google", acct);
  return back("");
}
async function oauthDisconnect(u) {
  const c = await getConnection(u, "google");
  if (!c) return;
  try { const tok = decrypt(c.refresh_enc); await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(tok), { method: "POST" }); } catch (e) {}
  await pool.query(`DELETE FROM ast_connection WHERE id=$1`, [c.id]);
  await log(u.tenant_id, u.email, "disconnect.google", c.account_email);
}

const TOOLS = [
  { name: "now", description: "התאריך והשעה הנוכחיים בישראל, ושם היום בשבוע. השתמש/י לפני כל חישוב של 'מחר', 'יום רביעי הקרוב' וכדומה.", input_schema: { type: "object", properties: {} } },
  { name: "list_tasks", description: "רשימת המשימות של המשתמש/ת. scope: open (פתוחות, ברירת מחדל) · today (פתוחות שמועדן היום או שעבר) · done · all.", input_schema: { type: "object", properties: { scope: { type: "string", enum: ["open", "today", "done", "all"] } } } },
  { name: "add_task", description: "הוספת משימה חדשה.", input_schema: { type: "object", properties: { title: { type: "string" }, notes: { type: "string" }, dueDate: { type: "string", description: "YYYY-MM-DD" }, dueTime: { type: "string", description: "HH:MM" }, priority: { type: "integer", description: "1 גבוה · 2 רגיל · 3 נמוך" } }, required: ["title"] } },
  { name: "update_task", description: "עדכון משימה: סימון כבוצעה (status=done), דחייה (dueDate), שינוי כותרת, ביטול (status=dropped).", input_schema: { type: "object", properties: { id: { type: "integer" }, title: { type: "string" }, notes: { type: "string" }, dueDate: { type: "string" }, dueTime: { type: "string" }, priority: { type: "integer" }, status: { type: "string", enum: ["open", "done", "dropped"] } }, required: ["id"] } },
  { name: "list_reminders", description: "התזכורות הממתינות.", input_schema: { type: "object", properties: {} } },
  { name: "add_reminder", description: "קביעת תזכורת שתישלח במועד נתון (באתר, ובווטסאפ אם מקושר). remindAt בפורמט ISO 8601 עם אזור זמן ישראל (+02:00 / +03:00).", input_schema: { type: "object", properties: { text: { type: "string" }, remindAt: { type: "string" } }, required: ["text", "remindAt"] } },
  { name: "cancel_reminder", description: "ביטול תזכורת לפי מזהה.", input_schema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "list_calendar_events", description: "אירועי היומן האישי (גוגל ו/או יומן ICS מחובר, כמו יומן אפל) בטווח תאריכים. fromDate/toDate בפורמט YYYY-MM-DD (ברירת מחדל: היום). אם גוגל לא חובר — יוחזר needs-google.", input_schema: { type: "object", properties: { fromDate: { type: "string" }, toDate: { type: "string" } } } },
  { name: "search_email", description: "חיפוש במייל (גוגל). query בתחביר Gmail, למשל 'from:aviad newer_than:3d' או 'is:unread'. מחזיר נושא, שולח, תאריך ותקציר.", input_schema: { type: "object", properties: { query: { type: "string" }, max: { type: "integer" } } } },
  { name: "read_email", description: "קריאת מייל מלא לפי מזהה שהתקבל מ-search_email.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  /* ---- משק בית: רשימות, תורנויות, הוצאות ---- */
  { name: "list_items", description: "תוכן רשימה משותפת (ברירת מחדל: רשימת הקניות). הרשימות משותפות לכל בני הבית.", input_schema: { type: "object", properties: { list: { type: "string", description: "שם הרשימה, ברירת מחדל 'קניות'" } } } },
  { name: "add_list_items", description: "הוספת פריטים לרשימה משותפת (קניות או כל רשימה אחרת). items = מערך של פריטים; כל פריט {text, qty?}. פריט שכבר ברשימה לא יוכפל.", input_schema: { type: "object", properties: { list: { type: "string" }, items: { type: "array", items: { type: "object", properties: { text: { type: "string" }, qty: { type: "string" } }, required: ["text"] } } }, required: ["items"] } },
  { name: "check_list_items", description: "סימון פריטים ברשימה כנקנו/בוצעו (או ביטול הסימון עם done=false). texts = חלקי טקסט של הפריטים, או all=true לכל הרשימה.", input_schema: { type: "object", properties: { list: { type: "string" }, texts: { type: "array", items: { type: "string" } }, ids: { type: "array", items: { type: "integer" } }, all: { type: "boolean" }, done: { type: "boolean" } } } },
  { name: "clear_done_items", description: "מחיקת הפריטים המסומנים מרשימה (ניקוי אחרי קנייה).", input_schema: { type: "object", properties: { list: { type: "string" } } } },
  { name: "list_chores", description: "התורנויות של הבית — מה, של מי התור עכשיו, ומתי.", input_schema: { type: "object", properties: {} } },
  { name: "add_chore", description: "יצירת תורנות שמתחלפת בין בני הבית. people = שמות לפי סדר הסבב. cadence: daily / weekly / once.", input_schema: { type: "object", properties: { title: { type: "string" }, people: { type: "array", items: { type: "string" } }, cadence: { type: "string", enum: ["daily", "weekly", "once"] }, nextDate: { type: "string", description: "YYYY-MM-DD" } }, required: ["title"] } },
  { name: "chore_done", description: "סימון תורנות כבוצעה — התור עובר לבא/ה בסבב. מזהים לפי id או לפי חלק מהכותרת.", input_schema: { type: "object", properties: { id: { type: "integer" }, title: { type: "string" }, by: { type: "string", description: "מי ביצע/ה, אם לא מי שבתור" } } } },
  { name: "household_info", description: "מי בבית (בני הבית שחולקים רשימות ותורנויות) וקוד ההזמנה לצירוף בן/בת זוג.", input_schema: { type: "object", properties: {} } },
  { name: "add_expense", description: "רישום הוצאה: amount בשקלים, category אחת מ: מזון · בית · ילדים · רכב · בריאות · פנאי · ביגוד · חשבונות · אחר (אפשר לתת תיאור חופשי והוא ימופה), note = בית העסק/תיאור קצר, date YYYY-MM-DD (ברירת מחדל היום).", input_schema: { type: "object", properties: { amount: { type: "number" }, category: { type: "string" }, note: { type: "string" }, date: { type: "string" } }, required: ["amount"] } },
  { name: "list_expenses", description: "הוצאות בטווח תאריכים (ברירת מחדל: מתחילת החודש) עם סכום כולל ופילוח לפי קטגוריה.", input_schema: { type: "object", properties: { fromDate: { type: "string" }, toDate: { type: "string" } } } },
  { name: "expense_summary", description: "סיכום הוצאות: השבוע, החודש (לפי קטגוריות) והחודש הקודם להשוואה.", input_schema: { type: "object", properties: {} } },
  { name: "plan_day", description: "הנתונים לתכנון היום: אירועי היומן, המשימות הפתוחות (כולל שעבר מועדן) ותזכורות. השתמש/י כשמבקשים לתכנן או לסדר את היום, ואז הצע/י לוח זמנים לפי שעות עם הפסקות, והצע/י מה לדחות.", input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD, ברירת מחדל היום" } } } },
];

async function runTool(u, name, input) {
  input = input || {};
  switch (name) {
    case "now": return nowParts();
    case "list_tasks": return { tasks: await listTasks(u, input.scope || "open") };
    case "add_task": return addTask(u, input, "chat");
    case "update_task": return updateTask(u, input);
    case "list_reminders": return { reminders: await listReminders(u, false) };
    case "add_reminder": return addReminder(u, input);
    case "cancel_reminder": return cancelReminder(u, input.id);
    case "list_calendar_events": return toolCalendar(u, input);
    case "search_email": return toolSearchEmail(u, input);
    case "read_email": return toolReadEmail(u, input);
    case "list_items": return listOne(u, input.list);
    case "add_list_items": return addListItems(u, input, "chat");
    case "check_list_items": return checkListItems(u, input);
    case "clear_done_items": return clearDoneItems(u, input.list);
    case "list_chores": return { chores: await listChores(u) };
    case "add_chore": return addChore(u, input);
    case "chore_done": return choreDone(u, input);
    case "household_info": return { household: await householdOut(u), hint: "להצטרפות: בן/בת הזוג נכנס/ת לאתר של נוני ← הבית ← הצטרפות עם הקוד." };
    case "add_expense": return addExpense(u, input, u.channel === "wa" ? "wa" : "chat");
    case "list_expenses": return listExpenses(u, input);
    case "expense_summary": return expenseSummary(u);
    case "plan_day": return planData(u, input.date);
    default: return { error: "כלי לא מוכר: " + name };
  }
}


/* ============================================================
   ווטסאפ — WhatsApp Cloud API (Meta)
   קישור: המשתמש/ת מקליד/ה טלפון באתר ← מקבל/ת קוד ← שולח/ת "קוד 123456"
   למספר של נוני ← מקושר. אחר כך כל הודעה בווטסאפ = שיחה עם נוני.
   ============================================================ */
function normPhone(p) {
  let d = String(p || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("0") && d.length >= 9 && d.length <= 10) d = "972" + d.slice(1);   // מספר ישראלי מקומי
  return /^\d{10,15}$/.test(d) ? d : "";
}
async function waLinkOut(u) {
  const r = await pool.query(`SELECT phone, code, verified_at FROM noni_wa WHERE user_id=$1`, [u.id]);
  const w = r.rows[0];
  return { available: !!WA_PHONE_ID, number: WA_DISPLAY_NUMBER, phone: w ? w.phone : "", linked: !!(w && w.verified_at), code: w && !w.verified_at ? w.code : "" };
}
async function waSend(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error("ווטסאפ לא מוגדר");
  const r = await fetch(`${process.env.WA_API_BASE || "https://graph.facebook.com/v21.0"}/${WA_PHONE_ID}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + WA_TOKEN },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: String(text).slice(0, 4000) } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("WhatsApp " + r.status + ": " + JSON.stringify(j).slice(0, 200));
  return j;
}
async function waSendTemplate(to, name, param) {
  const r = await fetch(`${process.env.WA_API_BASE || "https://graph.facebook.com/v21.0"}/${WA_PHONE_ID}/messages`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + WA_TOKEN },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name, language: { code: "he" }, components: [{ type: "body", parameters: [{ type: "text", text: String(param).slice(0, 900) }] }] } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("WhatsApp template " + r.status + ": " + JSON.stringify(j).slice(0, 200));
  return j;
}
function waSignatureOk(raw, header) {
  if (!WA_APP_SECRET) return true;
  const h = String(header || "").replace(/^sha256=/, "");
  const mac = crypto.createHmac("sha256", WA_APP_SECRET).update(raw).digest("hex");
  return h.length === mac.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(mac));
}
async function waConversation(u) {
  const c = await pool.query(`SELECT id FROM ast_conversation WHERE user_id=$1 AND title='ווטסאפ' ORDER BY id DESC LIMIT 1`, [u.id]);
  if (c.rows[0]) return c.rows[0].id;
  const n = await pool.query(`INSERT INTO ast_conversation (tenant_id,user_id,title) VALUES ($1,$2,'ווטסאפ') RETURNING id`, [u.tenant_id, u.id]);
  return n.rows[0].id;
}
async function waHandleText(from, text) {
  const w = await pool.query(`SELECT w.*, u.id AS uid FROM noni_wa w JOIN ast_user u ON u.id=w.user_id WHERE w.phone=$1`, [from]);
  const link = w.rows[0];
  const m = text.match(/^\s*(?:קוד|code)\s*[:\-]?\s*(\d{6})\s*$/i);
  if (m) {
    if (link && link.code === m[1]) { await pool.query(`UPDATE noni_wa SET verified_at=now(), code=NULL, updated_at=now() WHERE user_id=$1`, [link.user_id]); await log(DEFAULT_TENANT, from.slice(-4), "wa.linked", ""); return "מעולה, המספר מקושר. מעכשיו אפשר פשוט לכתוב לי כאן — למשל \"תזכירי לי מחר ב-8 להתקשר לרופא\"."; }
    return "הקוד לא תואם. בדקו באתר של נוני, בהגדרות ← ווטסאפ, ושלחו שוב \"קוד\" ואת שש הספרות.";
  }
  if (!link || !link.verified_at) return `היי, כאן נוני. כדי שאוכל לעזור צריך לקשר את המספר הזה לחשבון: נכנסים לאתר${PUBLIC_URL ? " " + PUBLIC_URL : ""}, הגדרות ← ווטסאפ, מקלידים את הטלפון ומקבלים קוד — ושולחים לי כאן "קוד" ואת שש הספרות.`;
  const u = await resolveUser(await (async () => (await pool.query(`SELECT email FROM ast_user WHERE id=$1`, [link.user_id])).rows[0].email)());
  if (!u || u.active === false) return "החשבון אינו פעיל.";
  u.channel = "wa";
  const left = await usageLeft(u);
  if (left <= 0) return `הגעת למגבלה של ${DAILY_LIMIT} הודעות היום. נמשיך מחר.`;
  const convId = await waConversation(u);
  const msgs = await pool.query(`SELECT role, content FROM ast_message WHERE conversation_id=$1 ORDER BY id DESC LIMIT ${MAX_HISTORY}`, [convId]);
  const hist = msgs.rows.reverse().filter(m => m.role === "user" || m.role === "assistant").map(m => ({ role: m.role, content: m.content }));
  while (hist.length && hist[0].role !== "user") hist.shift();
  hist.push({ role: "user", content: text.slice(0, MAX_QUESTION) });
  const r = await runAssistant(u, hist);
  await pool.query(`INSERT INTO ast_message (conversation_id, role, content) VALUES ($1,'user',$2)`, [convId, text.slice(0, MAX_QUESTION)]);
  await pool.query(`INSERT INTO ast_message (conversation_id, role, content, tools_used) VALUES ($1,'assistant',$2,$3)`, [convId, r.answer, r.used.join(",")]);
  await pool.query(`UPDATE ast_conversation SET updated_at=now() WHERE id=$1`, [convId]);
  await usageBump(u, r.usage).catch(() => {});
  await log(u.tenant_id, u.email, "wa.chat", r.used.join(","));
  return r.answer;
}
/* הודעה נכנסת → טקסט לעוזרת: טקסט כמו שהוא; קול ← תמלול; תמונה/מסמך ← תיאור ממוקד (קבלה, פתק, הזמנה);
   הודעה שהועברה מסומנת כך. המדיה נמשכת מ-Meta עם האסימון ונשלחת ל-Gemini (רב-אופני) באותו פרויקט. */
async function waIncoming(m) {
  const fwd = m.context && (m.context.forwarded || m.context.frequently_forwarded) ? "[הודעה שהועברה] " : "";
  if (m.type === "text" && m.text) return fwd + String(m.text.body || "");
  if (m.type === "audio" && m.audio) { const t = await waMediaToText(m.audio.id, m.audio.mime_type, "audio"); return t ? "[הודעה קולית] " + t : "לא הצלחתי להבין את ההודעה הקולית. אפשר לכתוב?"; }
  if (m.type === "image" && m.image) { const t = await waMediaToText(m.image.id, m.image.mime_type, "image"); return fwd + "[תמונה] " + (t || "(לא זוהה תוכן)") + (m.image.caption ? "\nכיתוב: " + m.image.caption : ""); }
  if (m.type === "document" && m.document && /^(image\/|application\/pdf)/.test(m.document.mime_type || "")) { const t = await waMediaToText(m.document.id, m.document.mime_type, "image"); return fwd + "[מסמך] " + (t || "(לא זוהה תוכן)") + (m.document.caption ? "\nכיתוב: " + m.document.caption : ""); }
  if (m.type === "location" && m.location) return `[מיקום] ${m.location.name || ""} ${m.location.address || ""} (${m.location.latitude},${m.location.longitude})`;
  if (m.type === "contacts") return "[איש קשר] " + JSON.stringify(m.contacts || []).slice(0, 600);
  if (m.type === "reaction" || m.type === "sticker") return "";
  return "";
}
async function waMediaToText(mediaId, mime, kind) {
  if (!WA_TOKEN || !mediaId) return "";
  const base = process.env.WA_API_BASE || "https://graph.facebook.com/v21.0";
  const meta = await fetch(`${base}/${mediaId}`, { headers: { Authorization: "Bearer " + WA_TOKEN } }).then(r => r.json()).catch(() => null);
  if (!meta || !meta.url) return "";
  const bin = await fetch(meta.url, { headers: { Authorization: "Bearer " + WA_TOKEN } });
  if (!bin.ok) return "";
  const buf = Buffer.from(await bin.arrayBuffer());
  if (buf.length > 20e6) return "";
  const prompt = kind === "audio"
    ? "תמלל/י את ההקלטה במדויק, בשפת הדובר/ת (בדרך כלל עברית). החזר/י רק את התמלול, בלי הקדמות."
    : "זו תמונה ששלח/ה משתמש/ת לעוזרת אישית. תאר/י בקצרה ובעברית את מה שרלוונטי לפעולה: אם זו קבלה — כתוב/י 'קבלה:' ואז בית העסק, הסכום הכולל, התאריך ו-3 הפריטים העיקריים; אם זו רשימה או פתק בכתב יד — העתק/י את הפריטים שורה-שורה; אם זו הזמנה או מודעה לאירוע — שם האירוע, תאריך, שעה ומקום; אם זה צילום מסך של הודעה — תמצת/י אותה. אחרת — משפט אחד על מה רואים.";
  return geminiMedia(prompt, mime || (kind === "audio" ? "audio/ogg" : "image/jpeg"), buf);
}
async function geminiMedia(prompt, mime, buf) {
  if (!VERTEX_PROJECT) return "";
  const url = `https://${geminiHost(GEMINI_REGION)}/v1/projects/${VERTEX_PROJECT}/locations/${GEMINI_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: String(mime).split(";")[0], data: buf.toString("base64") } }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 800 } };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + await vertexToken() }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) { console.error("gemini media", res.status, JSON.stringify(j).slice(0, 200)); return ""; }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  return parts.filter(p => typeof p.text === "string" && !p.thought).map(p => p.text).join("\n").trim().slice(0, 3000);
}
async function waWebhook(req, res) {
  let raw = ""; for await (const ch of req) { raw += ch; if (raw.length > 200000) break; }
  if (!waSignatureOk(raw, req.headers["x-hub-signature-256"])) { res.writeHead(403); return res.end(); }
  let body; try { body = JSON.parse(raw); } catch (e) { res.writeHead(400); return res.end(); }
  const jobs = [];
  for (const e of body.entry || []) for (const ch of e.changes || []) {
    const v = ch.value || {};
    for (const m of v.messages || []) {
      if (!m.from) continue;
      jobs.push(waIncoming(m).then(text => text ? waHandleText(normPhone(m.from) || m.from, text).then(reply => waSend(m.from, reply)) : null).catch(err => console.error("wa", String(err.message || err).slice(0, 200))));
    }
  }
  await Promise.all(jobs);   // Cloud Run מקצה CPU רק בזמן הבקשה — מסיימים לפני שעונים
  res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}");
}
async function channelConversation(u, title) {
  const c = await pool.query(`SELECT id FROM ast_conversation WHERE user_id=$1 AND title=$2 ORDER BY id DESC LIMIT 1`, [u.id, title]);
  if (c.rows[0]) return c.rows[0].id;
  const n = await pool.query(`INSERT INTO ast_conversation (tenant_id,user_id,title) VALUES ($1,$2,$3) RETURNING id`, [u.tenant_id, u.id, title]);
  return n.rows[0].id;
}
/* אותו צינור כמו ווטסאפ: היסטוריה ← runAssistant ← שמירה ← מונה שימוש */
async function channelChat(u, text, channel, title) {
  u.channel = channel;
  const left = await usageLeft(u);
  if (left <= 0) return `הגעת למגבלה של ${DAILY_LIMIT} הודעות היום. נמשיך מחר.`;
  const convId = await channelConversation(u, title);
  const msgs = await pool.query(`SELECT role, content FROM ast_message WHERE conversation_id=$1 ORDER BY id DESC LIMIT ${MAX_HISTORY}`, [convId]);
  const hist = msgs.rows.reverse().filter(m => m.role === "user" || m.role === "assistant").map(m => ({ role: m.role, content: m.content }));
  while (hist.length && hist[0].role !== "user") hist.shift();
  hist.push({ role: "user", content: text.slice(0, MAX_QUESTION) });
  const r = await runAssistant(u, hist);
  await pool.query(`INSERT INTO ast_message (conversation_id, role, content) VALUES ($1,'user',$2)`, [convId, text.slice(0, MAX_QUESTION)]);
  await pool.query(`INSERT INTO ast_message (conversation_id, role, content, tools_used) VALUES ($1,'assistant',$2,$3)`, [convId, r.answer, r.used.join(",")]);
  await pool.query(`UPDATE ast_conversation SET updated_at=now() WHERE id=$1`, [convId]);
  await usageBump(u, r.usage).catch(() => {});
  await log(u.tenant_id, u.email, channel + ".chat", r.used.join(","));
  return r.answer;
}
/* ============================================================
   SMS — Twilio REST API (fetch בלבד). בלי משתני סביבה — כבוי בשקט.
   ============================================================ */
async function smsSend(to, text) {
  if (!smsReady()) throw new Error("SMS לא מוגדר");
  const body = new URLSearchParams({ To: "+" + String(to).replace(/^\+/, ""), Body: String(text).slice(0, 1200) });
  if (/^MG[0-9a-f]{32}$/i.test(TWILIO_FROM)) body.set("MessagingServiceSid", TWILIO_FROM); else body.set("From", TWILIO_FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(TWILIO_SID)}/Messages.json`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(TWILIO_SID + ":" + TWILIO_TOKEN).toString("base64") }, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Twilio " + r.status + ": " + String(j.message || j.code || "").slice(0, 160));
  return j.sid;
}
async function smsOut(u) {
  const r = await pool.query(`SELECT phone, verified_at, code FROM noni_sms WHERE user_id=$1`, [u.id]);
  const w = r.rows[0];
  return { available: smsReady(), phone: w ? w.phone : "", verified: !!(w && w.verified_at), pending: !!(w && !w.verified_at && w.code) };
}

/* תזכורות יוצאות — Cloud Scheduler כל דקה: POST /api/cron/reminders עם X-Cron-Key */
async function cronReminders() {
  const r = await pool.query(`SELECT r.id, r.text, r.user_id, w.phone, s.phone AS sms_phone FROM ast_reminder r
                              LEFT JOIN noni_wa w ON w.user_id=r.user_id AND w.verified_at IS NOT NULL
                              LEFT JOIN noni_sms s ON s.user_id=r.user_id AND s.verified_at IS NOT NULL
                              WHERE r.status='pending' AND r.remind_at <= now() AND (w.phone IS NOT NULL OR s.phone IS NOT NULL) ORDER BY r.remind_at LIMIT 50`);
  let sent = 0;
  for (const x of r.rows) {
    try {
      const txt = "תזכורת: " + x.text;
      let okAny = false, lastErr = null;
      if (x.sms_phone && smsReady()) {   // ערוץ ראשי: SMS
        try { await smsSend(x.sms_phone, "נוני · " + txt); okAny = true; } catch (e) { lastErr = e; }
      }
      if (!okAny && x.phone && WA_PHONE_ID) {   // חלופה: ווטסאפ
        try { try { await waSend(x.phone, txt); } catch (e) { if (WA_TEMPLATE_REMINDER) await waSendTemplate(x.phone, WA_TEMPLATE_REMINDER, x.text); else throw e; } okAny = true; }   // מחוץ לחלון 24 השעות — תבנית
        catch (e) { lastErr = e; }
      }
      if (!okAny) { if (lastErr) throw lastErr; continue; }   // אין ערוץ מוגדר — נשאר ממתין
      await pool.query(`UPDATE ast_reminder SET status='sent', sent_at=now() WHERE id=$1`, [x.id]);
      sent++;
    } catch (e) { console.error("cron reminder", x.id, String(e.message || e).slice(0, 160)); }
  }
  return sent;
}

/* ============================================================
   הנחיית המערכת — שלוש שכבות
   ============================================================ */
async function systemPrompt(u) {
  const pr = await pool.query(`SELECT kind,title,body FROM ast_platform_rule WHERE enabled ORDER BY sort_order,id`);
  const pf = await pool.query(`SELECT key,value FROM ast_user_pref WHERE user_id=$1`, [u.id]);
  const n = nowParts();
  const lines = [];
  lines.push(`את נוני — העוזרת האישית של ${u.display_name || "המשתמש/ת"}. חמה, ישירה, מעשית; עוזרת לסדר את היום ואת הבית: משימות, תזכורות, יומן ומייל, רשימת קניות ורשימות משותפות, תורנויות בבית, מעקב הוצאות ותכנון היום.`);
  if (u.household_id) lines.push("יש למשתמש/ת משק בית משותף: רשימות, תורנויות והוצאות משותפות לבני הבית."); else lines.push("עדיין אין משק בית משותף; רשימות ותורנויות יהיו אישיות עד שיצורף/תצורף בן/בת זוג (household_info נותן קוד הזמנה).");
  lines.push(`עכשיו: יום ${n.weekday}, ${n.date} ${n.time} (${TZ}). תאריכים יחסיים ("מחר", "יום שלישי") מחושבים מכאן.`);
  if (u.role === "platform_admin") lines.push("המשתמש/ת היא מנהלת הפלטפורמה.");
  if (u.channel === "wa") lines.push(("הערוץ: ווטסאפ") + " — תשובות קצרות במיוחד, בלי עיצוב Markdown (בלי כוכביות וכותרות), אפשר אמוג'י אחד לכל היותר. הודעות שמתחילות ב-[הודעה קולית], [תמונה] או [הודעה שהועברה] הן תוכן שהמשתמש/ת שלח/ה — פעל/י לפי הכוונה: קבלה ← add_expense; רשימה/פתק ← add_list_items או add_task; הזמנה לאירוע ← add_reminder/add_task עם התאריך; ואשר/י בקצרה מה נרשם.");
  lines.push("");
  lines.push("## כללי הפלטפורמה");
  for (const r of pr.rows) lines.push(`- ${r.title}: ${r.body}`);
  if (pf.rows.length) { lines.push(""); lines.push("## העדפות אישיות"); for (const r of pf.rows) lines.push(`- ${r.key}: ${r.value}`); }
  lines.push("");
  lines.push("## כלים");
  lines.push("הודעה שמתחילה ב-[הודעה קולית] היא תמלול של הקלטה: הבן/י את הכוונה ופעל/י ישירות (למשל 'שילמתי ארבעים שקל על קפה' ← add_expense; 'תוסיפי לקניות' ← add_list_items; 'תזכירי לי' ← add_reminder; 'מחר אני צריכה' ← add_task), ואשר/י בקצרה מה נרשם ואיפה.");
  lines.push("משימות, תזכורות, פריטי רשימה, תורנויות והוצאות נשמרים דרך הכלים בלבד — אל תאמר/י 'רשמתי' בלי שהכלי הופעל והחזיר הצלחה. 'תוסיפי לקניות חלב ולחם' = add_list_items. 'שילמתי 120 בסופר' / 'יצא לי 80 על דלק' = add_expense (הקטגוריה לפי ההקשר). 'קניתי את החלב' = check_list_items. 'מי בתור להוציא זבל' = list_chores. תכנון היום = plan_day ואז לוח זמנים מוצע. ליומן האישי ולמייל — list_calendar_events / search_email / read_email; אם מוחזר needs-google — הפנ/י להגדרות ← חיבורים, בלי לנסות שוב. אל תסכם/י מייל שלא נקרא בפועל בכלי.");
  lines.push("תשובות קצרות, בעברית, בלי כותרות מיותרות. רשימות — רק כשיש כמה פריטים. אל תחזור/תחזרי על השאלה.");
  return lines.join("\n");
}

/* ============================================================
   ספקי מודל — Vertex AI (ברירת מחדל) · Anthropic ישיר · mock
   ============================================================ */
let googleAuth = null;
async function vertexToken() {
  if (!googleAuth) {
    const { GoogleAuth } = require("google-auth-library");
    googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  }
  const client = await googleAuth.getClient();
  const t = await client.getAccessToken();
  return t.token || t;
}
async function callModel(system, messages) {
  if (LLM_PROVIDER === "mock") return mockModel(system, messages);
  if (LLM_PROVIDER === "gemini") return geminiModel(system, messages);
  // היסטוריה שנוצרה עם gemini עשויה לשאת שדה sig בבלוקי tool_use — Claude לא מכיר אותו
  messages = messages.map(m => Array.isArray(m.content) ? { ...m, content: m.content.map(c => { if (c && c.sig) { const { sig, ...rest } = c; return rest; } return c; }) } : m);
  const body = { max_tokens: 1200, system, messages, tools: TOOLS, temperature: 0.2 };
  let url, headers;
  if (LLM_PROVIDER === "vertex") {
    if (!VERTEX_PROJECT) throw new Error("חסר VERTEX_PROJECT");
    url = `https://${vertexHost(VERTEX_REGION)}/v1/projects/${VERTEX_PROJECT}/locations/${VERTEX_REGION}/publishers/anthropic/models/${MODEL}:rawPredict`;
    headers = { "Content-Type": "application/json", Authorization: "Bearer " + await vertexToken() };
    body.anthropic_version = "vertex-2023-10-16";
  } else {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("חסר ANTHROPIC_API_KEY");
    url = "https://api.anthropic.com/v1/messages";
    headers = { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
    body.model = MODEL;
  }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error("המודל החזיר שגיאה " + res.status + ": " + String(j && (j.error && j.error.message || JSON.stringify(j)) || "").slice(0, 200));
  return j;
}

/* gemini — מתאם: הודעות וכלים בפורמט Anthropic ⇄ Gemini (Vertex AI generateContent).
   הלולאה (runAssistant) לא יודעת על ההבדל — מקבלת בחזרה {content, stop_reason, usage} כרגיל. */
function geminiHost(r) { return vertexHost(r); }   // אותה לוגיקה: eu/us → נקודת קצה רב-אזורית, global, או אזור בודד
function geminiTools() {
  return [{ functionDeclarations: TOOLS.map(t => {
    const d = { name: t.name, description: t.description };
    const props = t.input_schema && t.input_schema.properties || {};
    if (Object.keys(props).length) d.parameters = { type: "object", properties: props, ...(t.input_schema.required ? { required: t.input_schema.required } : {}) };
    return d;
  }) }];
}
function geminiContents(messages) {
  const names = {};   // tool_use_id → שם הכלי (ל-functionResponse)
  const out = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts = [];
    if (typeof m.content === "string") { if (m.content.trim()) parts.push({ text: m.content }); }
    else for (const c of (m.content || [])) {
      if (c.type === "text" && c.text && c.text.trim()) parts.push({ text: c.text });
      else if (c.type === "tool_use") { names[c.id] = c.name; parts.push({ functionCall: { name: c.name, args: c.input || {} }, ...(c.sig ? { thoughtSignature: c.sig } : {}) }); }   // Gemini 3 דורש להחזיר את חתימת המחשבה
      else if (c.type === "tool_result") {
        let r; try { r = JSON.parse(c.content); } catch (e) { r = c.content; }
        parts.push({ functionResponse: { name: names[c.tool_use_id] || "tool", response: (r && typeof r === "object" && !Array.isArray(r)) ? r : { result: r } } });
      }
    }
    if (!parts.length) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts); else out.push({ role, parts });
  }
  return out;
}
async function geminiModel(system, messages) {
  if (!VERTEX_PROJECT) throw new Error("חסר VERTEX_PROJECT");
  const url = `https://${geminiHost(GEMINI_REGION)}/v1/projects/${VERTEX_PROJECT}/locations/${GEMINI_REGION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: geminiContents(messages),
    tools: geminiTools(),
    generationConfig: { temperature: 0.2, maxOutputTokens: 1200 }
  };
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + await vertexToken() }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error("המודל החזיר שגיאה " + res.status + ": " + String(j && (j.error && j.error.message || JSON.stringify(j)) || "").slice(0, 200));
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const content = [];
  for (const p of parts) {
    if (p.thought) continue;
    if (p.functionCall) content.push({ type: "tool_use", id: "g_" + crypto.randomBytes(6).toString("hex"), name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { sig: p.thoughtSignature } : {}) });
    else if (typeof p.text === "string") content.push({ type: "text", text: p.text });
  }
  const um = j.usageMetadata || {};
  return { content, stop_reason: content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn", usage: { input_tokens: um.promptTokenCount || 0, output_tokens: um.candidatesTokenCount || 0 } };
}

/* mock — לבדיקות מקומיות ולדמו: מזהה כמה בקשות פשוטות ומפעיל כלים, בלי מודל */
async function mockModel(system, messages) {
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  // תשובה אחרי תוצאת כלי
  if (last.role === "user" && Array.isArray(last.content) && last.content[0] && last.content[0].type === "tool_result") {
    const results = last.content.map(c => { try { return JSON.parse(c.content); } catch (e) { return {}; } });
    const used = (prev && Array.isArray(prev.content) ? prev.content.filter(c => c.type === "tool_use").map(c => c.name) : []);
    const texts = results.map((r, i) => {
      if (r.error) return "לא הצלחתי: " + (r.message || r.error);
      if (r.task) return (used[i] === "add_task" ? "הוספתי את המשימה: " : "עדכנתי את המשימה: ") + r.task.title + (r.task.dueDate ? " (עד " + r.task.dueDate + ")" : "");
      if (r.guidance) return `תכנון ל-${r.date}: ${r.tasks.length} משימות פתוחות${r.calendar && r.calendar.length ? ", " + r.calendar.length + " אירועים ביומן" : ""}. (במצב בדיקה אין מודל שמסדר לוח זמנים.)`;
      if (r.tasks) return r.tasks.length ? "המשימות שלך:\n" + r.tasks.map(t => "• " + t.title + (t.dueDate ? " — " + t.dueDate : "")).join("\n") : "אין משימות פתוחות.";
      if (r.reminder) return "קבעתי תזכורת: " + r.reminder.text;
      if (r.reminders) return r.reminders.length ? "תזכורות ממתינות:\n" + r.reminders.map(t => "• " + t.text).join("\n") : "אין תזכורות ממתינות.";
      if (r.answer) return r.answer;
      if (r.events) return r.events.length ? "ביומן:\n" + r.events.map(e => "• " + e.start + " — " + e.title).join("\n") : "אין אירועים ביומן בטווח הזה.";
      if (r.messages) return r.messages.length ? "מיילים:\n" + r.messages.map(m => "• " + m.subject + " (" + m.from + ")").join("\n") : "אין מיילים חדשים.";
      if (r.items) return r.items.length ? `רשימת ${r.list}:\n` + r.items.map(i => (i.done ? "✓ " : "• ") + i.text + (i.qty ? " ×" + i.qty : "")).join("\n") : `רשימת ${r.list} ריקה.`;
      if (r.expense) return `רשמתי הוצאה של ${r.expense.amount} ₪ (${r.expense.category}${r.expense.note ? " · " + r.expense.note : ""}).`;
      if (r.month) return `החודש: ${r.month.total} ₪ · השבוע: ${r.week.total} ₪ · חודש שעבר: ${r.lastMonth.total} ₪.`;
      if (r.chores) return r.chores.length ? "תורנויות:\n" + r.chores.map(c => `• ${c.title} — התור של ${c.turn}`).join("\n") : "אין תורנויות.";
      if (r.guidance) return `תכנון ל-${r.date}: ${r.tasks.length} משימות פתוחות${r.calendar && r.calendar.length ? ", " + r.calendar.length + " אירועים ביומן" : ""}. (במצב בדיקה אין מודל שמסדר לוח זמנים.)`;
      if (r.date) return `היום יום ${r.weekday}, ${r.date}, השעה ${r.time}.`;
      return JSON.stringify(r);
    });
    return { content: [{ type: "text", text: texts.join("\n\n") }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
  }
  const q = typeof last.content === "string" ? last.content : "";
  const id = () => "toolu_" + Math.random().toString(36).slice(2, 10);
  const use = (name, input) => ({ content: [{ type: "tool_use", id: id(), name, input }], stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } });
  if (/תזכורות/.test(q)) return use("list_reminders", {});
  if (/^(?:תזכירי לי|תזכורת)/.test(q) && !/^תזכירי לי ל/.test(q)) {   // "תזכירי לי מחר ב-8 להתקשר" ← תזכורת בשעה המבוקשת (שעון ישראל)
    const n = nowParts(), tomorrow = /מחר/.test(q), hm = q.match(/ב-?(\d{1,2})(?::(\d{2}))?(?=\s|$)/);
    let when;
    if (hm) {
      const off = (() => { const t = new Date(n.date + "T12:00:00Z"); const h = +new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(t); return h - 12; })();
      const base = new Date(n.date + "T00:00:00Z"); if (tomorrow) base.setUTCDate(base.getUTCDate() + 1);
      when = new Date(base.getTime() + ((+hm[1] - off) * 60 + +(hm[2] || 0)) * 60e3);
      if (!tomorrow && when <= new Date()) when = new Date(when.getTime() + 86400e3);
    } else when = new Date(Date.now() + 3600e3);
    const text = q.replace(/^(?:תזכירי לי|תזכורת)\s*/, "").replace(/\s*(מחר|היום)\s*/g, " ").replace(/\s*ב-?\d{1,2}(?::\d{2})?(?=\s|$)\s*/, " ").trim() || "תזכורת";
    return use("add_reminder", { text, remindAt: when.toISOString() });
  }
  if (/תכנני|תכנון היום|תסדרי לי את היום/.test(q)) return use("plan_day", {});
  let m = q.match(/^(?:תוסיפי?|הוסיפי?)\s*לקניות:?\s*(.+)$/); if (m) return use("add_list_items", { items: m[1].split(/[,،]| ו(?=\S)/).map(x => x.trim()).filter(Boolean) });
  if (/רשימת הקניות|מה לקנות|מה ברשימה/.test(q)) return use("list_items", {});
  m = q.match(/(?:שילמתי|יצא לי|הוצאתי)\s*(\d+(?:\.\d+)?)\s*(?:₪|שקל|ש"ח)?\s*(?:על|ב-?|ל)?\s*(.*)$/); if (m) return use("add_expense", { amount: Number(m[1]), category: m[2], note: m[2] });
  if (/כמה הוצאתי|סיכום הוצאות|הוצאות החודש/.test(q)) return use("expense_summary", {});
  if (/תורנו/.test(q)) return use("list_chores", {});
  if (/^(מה )?(ה)?משימות|רשימת המשימות|מה פתוח/.test(q)) return use("list_tasks", { scope: "open" });
  m = q.match(/^(?:תוסיפי?|הוסיפי?|תרשמי?|רשמי?|תזכירי לי ל|משימה:?)\s*(.+)$/);
  if (m && !/תזכורת/.test(q)) {
    let title = m[1].trim(), dueDate;
    const n = nowParts();
    if (/מחר/.test(title)) { const d = new Date(n.date + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); dueDate = d.toISOString().slice(0, 10); title = title.replace(/\s*מחר\s*/, " ").trim(); }
    if (/היום/.test(title)) { dueDate = n.date; title = title.replace(/\s*היום\s*/, " ").trim(); }
    return use("add_task", Object.assign({ title }, dueDate ? { dueDate } : {}));
  }
  m = q.match(/(?:סיימתי|בוצע|תסמני? כבוצע)\s*(?:את\s*)?(?:משימה\s*)?(\d+)/);
  if (m) return use("update_task", { id: Number(m[1]), status: "done" });
  if (/יומן|פגיש|אחרי בית הספר|מה יש לי/.test(q)) return use("list_calendar_events", {});
  if (/מייל|דוא"?ל|הודעות חדשות/.test(q)) return use("search_email", { query: "newer_than:2d" });
  if (/שעה|תאריך|איזה יום/.test(q)) return use("now", {});
  return { content: [{ type: "text", text: "אני במצב בדיקה (בלי מודל). אפשר לנסות: \"תוסיפי משימה לקנות מתנה מחר\", \"תוסיפי לקניות חלב\", \"תזכירי לי מחר ב-8 להתקשר לרופא\", \"מה המשימות\"." }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
}

/* ============================================================
   לולאת הסוכן
   ============================================================ */
async function runAssistant(u, history) {
  const system = await systemPrompt(u);
  const messages = history.map(m => ({ role: m.role, content: m.content }));
  const used = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let touched = { tasks: false, reminders: false, lists: false, chores: false, expenses: false };
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const r = await callModel(system, messages);
    if (r.usage) { usage.input_tokens += r.usage.input_tokens || 0; usage.output_tokens += r.usage.output_tokens || 0; }
    const content = r.content || [];
    const toolUses = content.filter(c => c.type === "tool_use");
    if (r.stop_reason !== "tool_use" || !toolUses.length || round === MAX_TOOL_ROUNDS) {
      const text = content.filter(c => c.type === "text").map(c => c.text).join("\n").trim();
      return { answer: text || "לא התקבלה תשובה.", used, usage, touched };
    }
    messages.push({ role: "assistant", content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try { out = await runTool(u, tu.name, tu.input); } catch (e) { out = { error: "שגיאה בכלי: " + String(e.message || e).slice(0, 200) }; }
      used.push(tu.name);
      if (/task/.test(tu.name) && out && !out.error) touched.tasks = true;
      if (/reminder/.test(tu.name) && out && !out.error) touched.reminders = true;
      if (/list_items|clear_done/.test(tu.name) && out && !out.error) touched.lists = true;
      if (/chore/.test(tu.name) && out && !out.error) touched.chores = true;
      if (/expense/.test(tu.name) && out && !out.error) touched.expenses = true;
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
}

/* ============================================================
   שיחות
   ============================================================ */
async function loadConversation(u, id) {
  if (!id) return null;
  const c = await pool.query(`SELECT * FROM ast_conversation WHERE id=$1 AND user_id=$2`, [id, u.id]);
  if (!c.rows[0]) return null;
  const m = await pool.query(`SELECT role, content, tools_used, created_at FROM ast_message WHERE conversation_id=$1 ORDER BY id`, [id]);
  return { id: c.rows[0].id, title: c.rows[0].title, messages: m.rows.map(x => ({ role: x.role, content: x.content, tools: x.tools_used, at: x.created_at })) };
}
async function usageLeft(u) {
  const r = await pool.query(`SELECT questions FROM ast_usage WHERE user_id=$1 AND day=$2`, [u.id, nowParts().date]);
  return DAILY_LIMIT - (r.rows[0] ? r.rows[0].questions : 0);
}
async function usageBump(u, usage) {
  await pool.query(`INSERT INTO ast_usage (user_id, day, questions, input_tokens, output_tokens) VALUES ($1,$2,1,$3,$4)
    ON CONFLICT (user_id, day) DO UPDATE SET questions=ast_usage.questions+1, input_tokens=ast_usage.input_tokens+$3, output_tokens=ast_usage.output_tokens+$4`,
    [u.id, nowParts().date, usage.input_tokens || 0, usage.output_tokens || 0]);
}

/* ============================================================
   HTTP
   ============================================================ */
function json(res, code, obj, extra) {
  const h = Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, extra || {});
  res.writeHead(code, h); res.end(JSON.stringify(obj));
}
function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > (max || 12e6)) { reject(new Error("too-big")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => { d += c; if (d.length > 2e6) { reject(new Error("too-big")); req.destroy(); } });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(new Error("bad-json")); } });
    req.on("error", reject);
  });
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
function serveStatic(req, res, p) {
  const file = path.normalize(path.join(PUBLIC_DIR, p === "/" ? "index.html" : p));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "SAMEORIGIN",
    "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; frame-ancestors 'self'"
  });
  if (file.endsWith("index.html") || file.endsWith("list.html")) { const base = (process.env.PUBLIC_URL || "").replace(/\/$/, ""); return res.end(fs.readFileSync(file, "utf8").split("__PUBLIC_URL__").join(base)); }
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  /* בקשות ישירות לכתובות run.app הישנות ← הכתובת הקבועה. דרך ה-Worker יש X-Forwarded-Host (אין לולאה). */
  {
    const fh = String(req.headers["x-forwarded-host"] || "").toLowerCase(), h = String(req.headers.host || "").toLowerCase();
    if (CANON_HOST && fh !== CANON_HOST && h.endsWith(".run.app") && !/^\/api\/(wa\/webhook|cron\/|health)/.test(p)) {
      const loc = "https://" + CANON_HOST + req.url;
      res.writeHead(p === "/api/connect/google/callback" ? 302 : 301, { Location: loc, "Cache-Control": "no-store" }); return res.end();
    }
  }
  try {
    if (p === "/api/health") return json(res, 200, { ok: true, version: VERSION, provider: LLM_PROVIDER, model: LLM_PROVIDER === "gemini" ? GEMINI_MODEL : MODEL, region: LLM_PROVIDER === "gemini" ? GEMINI_REGION : VERTEX_REGION, auth: AUTH_MODE, db: !!process.env.DB_HOST || !!process.env.DB_SOCKET, google: googleReady(), googleScopes: GOOGLE_SCOPES, whatsapp: !!WA_PHONE_ID, sms: smsReady(), ics: true });
    if (p.startsWith("/l/")) return serveStatic(req, res, "/list.html");
    if (!p.startsWith("/api/")) return serveStatic(req, res, p);
    if (p === "/api/config" && req.method === "GET") return json(res, 200, { ok: true, googleClientId: GOOGLE_CLIENT_ID, auth: AUTH_MODE, whatsapp: !!WA_PHONE_ID, waNumber: WA_DISPLAY_NUMBER });

    await ensureSchema();

    /* ---- ציבורי: כניסה, ווטסאפ, cron ---- */
    if (p === "/api/auth/google" && req.method === "POST") {
      const b = await readBody(req);
      let prof; try { prof = await verifyGoogleIdToken(str(b.credential, 4000)); } catch (e) { return json(res, 401, { ok: false, error: "הכניסה עם Google נכשלה: " + String(e.message || e).slice(0, 120) }); }
      const u0 = await resolveUser(prof.email, prof);
      if (!u0 || u0.active === false) return json(res, 403, { ok: false, error: "החשבון אינו פעיל." });
      res.setHeader("Set-Cookie", await sessionCookie(prof.email));
      await log(DEFAULT_TENANT, prof.email, "login", "google");
      return json(res, 200, { ok: true, me: { email: u0.email, name: u0.display_name, role: u0.role } });
    }
    if (p === "/api/auth/logout" && req.method === "POST") { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`); return json(res, 200, { ok: true }); }
    if (p === "/api/wa/webhook" && req.method === "GET") {
      if (WA_VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === WA_VERIFY_TOKEN) { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(url.searchParams.get("hub.challenge") || ""); }
      res.writeHead(403); return res.end();
    }
    if (p === "/api/wa/webhook" && req.method === "POST") return waWebhook(req, res);
    if (p === "/api/cron/reminders" && req.method === "POST") {
      if (!CRON_KEY || req.headers["x-cron-key"] !== CRON_KEY) return json(res, 403, { ok: false, error: "forbidden" });
      return json(res, 200, { ok: true, sent: await cronReminders() });
    }

    /* ---- רשימה משותפת בקישור (בלי כניסה) ---- */
    if (p.startsWith("/api/l/")) {
      const [, , , tok, act] = p.split("/");
      const l = await sharedList(tok);
      if (!l) return json(res, 404, { ok: false, error: "הקישור לא תקף או שהשיתוף בוטל." });
      if (req.method === "GET") return json(res, 200, Object.assign({ ok: true }, await sharedListOut(l)));
      if (req.method === "POST" && act === "check") { const b = await readBody(req); await pool.query(`UPDATE noni_list_item SET done=$3, done_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE list_id=$1 AND id=$2`, [l.id, Number(b.id) || 0, b.done !== false]); return json(res, 200, Object.assign({ ok: true }, await sharedListOut(l))); }
      if (req.method === "POST" && act === "remove") { const b = await readBody(req); await pool.query(`DELETE FROM noni_list_item WHERE list_id=$1 AND id=$2`, [l.id, Number(b.id) || 0]); return json(res, 200, Object.assign({ ok: true }, await sharedListOut(l))); }
      if (req.method === "POST" && act === "add") { const b = await readBody(req); const text = str(b.text, 120).trim(); if (text) await pool.query(`INSERT INTO noni_list_item (list_id, text, qty, added_by) VALUES ($1,$2,$3,$4)`, [l.id, text, str(b.qty, 20), str(b.by, 40) || "אורח/ת"]); return json(res, 200, Object.assign({ ok: true }, await sharedListOut(l))); }
      return json(res, 405, { ok: false, error: "method" });
    }

    const email = await gateEmail(req);
    if (!email) return json(res, 401, { ok: false, error: "לא מחובר/ת.", login: true });
    const u = await resolveUser(email);
    if (!u) return json(res, 403, { ok: false, error: "החשבון לא נמצא." });
    if (u.tenant_active === false || u.active === false) return json(res, 403, { ok: false, error: "החשבון אינו פעיל." });

    const me = () => ({ email: u.email, name: u.display_name, role: u.role, tenant: { id: u.tenant_id, name: u.tenant_name, plan: u.plan } });

    /* ---- SMS: מספר טלפון לתזכורות (אימות בקוד) ---- */
    if (p === "/api/sms" && req.method === "POST") {
      if (!smsReady()) return json(res, 503, { ok: false, error: "SMS עדיין לא הופעל בשרת." });
      const b = await readBody(req); const phone = normPhone(str(b.phone, 30));
      if (!phone) return json(res, 400, { ok: false, error: "מספר טלפון לא תקין. למשל 050-1234567 או +972501234567." });
      const prev = (await pool.query(`SELECT code_at FROM noni_sms WHERE user_id=$1`, [u.id])).rows[0];
      if (prev && prev.code_at && Date.now() - new Date(prev.code_at) < 30000) return json(res, 429, { ok: false, error: "רגע, קוד נשלח עכשיו. נסי שוב בעוד חצי דקה." });
      const code = String(crypto.randomInt(100000, 999999));
      try { await smsSend(phone, `קוד האימות של נוני: ${code}`); } catch (e) { console.error("sms code", String(e.message).slice(0, 160)); return json(res, 502, { ok: false, error: "לא הצלחתי לשלוח מסרון למספר הזה." }); }
      await pool.query(`INSERT INTO noni_sms (user_id, phone, code, code_at, attempts, verified_at) VALUES ($1,$2,$3,now(),0,NULL)
        ON CONFLICT (user_id) DO UPDATE SET phone=$2, code=$3, code_at=now(), attempts=0, verified_at=NULL, updated_at=now()`, [u.id, phone, code]);
      await log(u.tenant_id, u.email, "sms.code", phone.slice(-4));
      return json(res, 200, { ok: true, connections: await connectionsOut(u) });
    }
    if (p === "/api/sms/verify" && req.method === "POST") {
      const b = await readBody(req); const code = str(b.code, 10).replace(/\D/g, "");
      const w = (await pool.query(`SELECT code, code_at, attempts FROM noni_sms WHERE user_id=$1`, [u.id])).rows[0];
      if (!w || !w.code) return json(res, 400, { ok: false, error: "אין קוד ממתין. שלחי קוד חדש." });
      if (w.attempts >= 5 || Date.now() - new Date(w.code_at) > 15 * 60000) return json(res, 400, { ok: false, error: "הקוד פג. שלחי קוד חדש." });
      if (code !== w.code) { await pool.query(`UPDATE noni_sms SET attempts=attempts+1 WHERE user_id=$1`, [u.id]); return json(res, 400, { ok: false, error: "הקוד שגוי." }); }
      await pool.query(`UPDATE noni_sms SET code=NULL, verified_at=now(), updated_at=now() WHERE user_id=$1`, [u.id]);
      await log(u.tenant_id, u.email, "sms.verified", "");
      return json(res, 200, { ok: true, connections: await connectionsOut(u) });
    }
    if (p === "/api/sms/test" && req.method === "POST") {
      const w = (await pool.query(`SELECT phone FROM noni_sms WHERE user_id=$1 AND verified_at IS NOT NULL`, [u.id])).rows[0];
      if (!w || !smsReady()) return json(res, 400, { ok: false, error: "אין מספר מאומת." });
      try { await smsSend(w.phone, "נוני: זו הודעת בדיקה — התזכורות יגיעו לכאן 🙂"); } catch (e) { return json(res, 502, { ok: false, error: "השליחה נכשלה." }); }
      return json(res, 200, { ok: true });
    }
    if (p === "/api/sms" && req.method === "DELETE") { await pool.query(`DELETE FROM noni_sms WHERE user_id=$1`, [u.id]); await log(u.tenant_id, u.email, "sms.remove", ""); return json(res, 200, { ok: true, connections: await connectionsOut(u) }); }

    /* ---- ווטסאפ: קישור המספר ---- */
    if (p === "/api/wa/link" && req.method === "GET") return json(res, 200, { ok: true, link: await waLinkOut(u) });
    if (p === "/api/wa/link" && req.method === "POST") {
      const b = await readBody(req); const phone = normPhone(str(b.phone, 30));
      if (!phone) return json(res, 400, { ok: false, error: "מספר טלפון לא תקין. למשל 050-1234567 או +972501234567." });
      const code = String(crypto.randomInt(100000, 999999));
      await pool.query(`INSERT INTO noni_wa (user_id, phone, code, verified_at) VALUES ($1,$2,$3,NULL)
        ON CONFLICT (user_id) DO UPDATE SET phone=$2, code=$3, verified_at=NULL, updated_at=now()`, [u.id, phone, code]);
      await log(u.tenant_id, u.email, "wa.link.start", phone.slice(-4));
      return json(res, 200, { ok: true, link: await waLinkOut(u) });
    }
    if (p === "/api/wa/link" && req.method === "DELETE") { await pool.query(`DELETE FROM noni_wa WHERE user_id=$1`, [u.id]); await log(u.tenant_id, u.email, "wa.unlink", ""); return json(res, 200, { ok: true, link: await waLinkOut(u) }); }

    if (p === "/api/me" && req.method === "GET") return json(res, 200, { ok: true, me: me(), version: VERSION });

    if (p === "/api/bootstrap" && req.method === "GET") {
      const [tasks, reminders, convs, left] = await Promise.all([
        listTasks(u, "all"), listReminders(u, false),
        pool.query(`SELECT id,title,updated_at FROM ast_conversation WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 20`, [u.id]), usageLeft(u)
      ]);
      const prefs = await pool.query(`SELECT key,value FROM ast_user_pref WHERE user_id=$1`, [u.id]);
      const connections = await connectionsOut(u);
      const [hh, lists, chores, expenses] = await Promise.all([householdOut(u), listsOut(u), listChores(u), expenseSummary(u)]);
      return json(res, 200, { ok: true, me: me(), version: VERSION, now: nowParts(), tasks, reminders, conversations: convs.rows, left, prefs: Object.fromEntries(prefs.rows.map(r => [r.key, r.value])), provider: LLM_PROVIDER, connections, household: hh, lists, chores, expenses, categories: EXPENSE_CATS });
    }

    /* ---- קול מהאתר: הקלטה מהמיקרופון ← תמלול (Gemini) ← הטקסט חוזר ללקוח ונשלח כהודעה רגילה ---- */
    if (p === "/api/voice" && req.method === "POST") {
      const mime = String(req.headers["content-type"] || "audio/webm").split(";")[0];
      if (!/^audio\//.test(mime)) return json(res, 400, { ok: false, error: "צריך קובץ שמע." });
      const buf = await readRaw(req, 12e6);
      if (buf.length < 800) return json(res, 400, { ok: false, error: "ההקלטה קצרה מדי." });
      const left = await usageLeft(u);
      if (left <= 0) return json(res, 429, { ok: false, error: "הגעת למגבלה היומית." });
      const text = await geminiMedia("תמלל/י את ההקלטה במדויק, בשפת הדובר/ת (בדרך כלל עברית). החזר/י רק את התמלול, בלי הקדמות ובלי סימני ציטוט. אם אין דיבור — החזר/י מחרוזת ריקה.", mime, buf);
      await log(u.tenant_id, u.email, "voice", buf.length);
      return json(res, 200, { ok: true, text: text.trim() });
    }

    if (p === "/api/chat" && req.method === "POST") {
      const b = await readBody(req);
      const text = str(b.message, MAX_QUESTION).trim();
      if (!text) return json(res, 400, { ok: false, error: "חסרה הודעה." });
      const left = await usageLeft(u);
      if (left <= 0) return json(res, 429, { ok: false, error: "הגעת למגבלה של " + DAILY_LIMIT + " שאלות היום. אפשר להמשיך מחר." });
      let conv = await loadConversation(u, Number(b.conversationId) || 0);
      if (!conv) {
        const c = await pool.query(`INSERT INTO ast_conversation (tenant_id,user_id,title) VALUES ($1,$2,$3) RETURNING id,title`, [u.tenant_id, u.id, text.slice(0, 60)]);
        conv = { id: c.rows[0].id, title: c.rows[0].title, messages: [] };
      }
      const hist = conv.messages.filter(m => m.role === "user" || m.role === "assistant").slice(-MAX_HISTORY).map(m => ({ role: m.role, content: m.content }));
      while (hist.length && hist[0].role !== "user") hist.shift();
      hist.push({ role: "user", content: text });
      const r = await runAssistant(u, hist);
      await pool.query(`INSERT INTO ast_message (conversation_id, role, content) VALUES ($1,'user',$2)`, [conv.id, text]);
      await pool.query(`INSERT INTO ast_message (conversation_id, role, content, tools_used) VALUES ($1,'assistant',$2,$3)`, [conv.id, r.answer, r.used.join(",")]);
      await pool.query(`UPDATE ast_conversation SET updated_at=now() WHERE id=$1`, [conv.id]);
      await usageBump(u, r.usage).catch(() => {});
      await log(u.tenant_id, u.email, "chat", "conv " + conv.id + " · " + r.used.join(","));
      const extra = {};
      if (r.touched.tasks) extra.tasks = await listTasks(u, "all");
      if (r.touched.reminders) extra.reminders = await listReminders(u, false);
      if (r.touched.lists) extra.lists = await listsOut(u);
      if (r.touched.chores) extra.chores = await listChores(u);
      if (r.touched.expenses) extra.expenses = await expenseSummary(u);
      return json(res, 200, Object.assign({ ok: true, conversationId: conv.id, answer: r.answer, tools: r.used, left: left - 1 }, extra));
    }

    if (p.startsWith("/api/conversations")) {
      const id = Number(p.split("/")[3] || 0);
      if (req.method === "GET" && id) { const c = await loadConversation(u, id); return c ? json(res, 200, { ok: true, conversation: c }) : json(res, 404, { ok: false, error: "השיחה לא נמצאה." }); }
      if (req.method === "DELETE" && id) { await pool.query(`DELETE FROM ast_conversation WHERE id=$1 AND user_id=$2`, [id, u.id]); return json(res, 200, { ok: true }); }
      if (req.method === "GET") { const c = await pool.query(`SELECT id,title,updated_at FROM ast_conversation WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50`, [u.id]); return json(res, 200, { ok: true, conversations: c.rows }); }
    }

    if (p === "/api/tasks" && req.method === "GET") return json(res, 200, { ok: true, tasks: await listTasks(u, url.searchParams.get("scope") || "all") });
    if (p === "/api/tasks" && req.method === "POST") { const r = await addTask(u, await readBody(req), "ui"); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, task: r.task, tasks: await listTasks(u, "all") }); }
    if (p.startsWith("/api/tasks/") && (req.method === "PATCH" || req.method === "POST")) {
      const r = await updateTask(u, Object.assign({}, await readBody(req), { id: Number(p.split("/")[3]) }));
      return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, task: r.task, tasks: await listTasks(u, "all") });
    }
    if (p === "/api/reminders" && req.method === "GET") return json(res, 200, { ok: true, reminders: await listReminders(u, url.searchParams.get("all") === "1") });
    if (p === "/api/reminders" && req.method === "POST") { const r = await addReminder(u, await readBody(req)); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, reminder: r.reminder, reminders: await listReminders(u, false) }); }
    if (p === "/api/reminders/due" && req.method === "POST") return json(res, 200, { ok: true, due: await dueReminders(u), reminders: await listReminders(u, false) });
    if (p.startsWith("/api/reminders/") && req.method === "DELETE") { const r = await cancelReminder(u, p.split("/")[3]); return r.error ? json(res, 404, { ok: false, error: r.error }) : json(res, 200, { ok: true, reminders: await listReminders(u, false) }); }

    /* ---- שלב 2: חיבורים ---- */
    if (p === "/api/connections" && req.method === "GET") return json(res, 200, { ok: true, connections: await connectionsOut(u) });
    if (p === "/api/connect/google" && req.method === "GET") return oauthStart(u, res);
    if (p === "/api/connect/google/callback" && req.method === "GET") return oauthCallback(u, url, res);
    if (p === "/api/connect/wish" && req.method === "POST") { const b = await readBody(req); const pr = String(b.provider || "").slice(0, 30); await log(u.tenant_id, u.email, "connect.wish", pr); return json(res, 200, { ok: true }); }
    if (p === "/api/connect/ics" && req.method === "POST") {
      const b = await readBody(req); const url = normIcsUrl(str(b.url, 2000));
      if (!url) return json(res, 400, { ok: false, error: "הקישור לא נראה כמו קישור ליומן. הוא אמור להתחיל ב-https:// או webcal://" });
      if (!CONN_KEY) return json(res, 503, { ok: false, error: "חסר מפתח הצפנה בשרת." });
      let evs; try { evs = await fetchIcs(url); } catch (e) { return json(res, 400, { ok: false, error: "לא הצלחתי לקרוא את היומן: " + String(e.name === "AbortError" ? "הזמן לטעינה עבר" : e.message).slice(0, 140) }); }
      const label = str(b.label, 60).trim() || new URL(url).hostname.replace(/^www\./, "");
      await pool.query(`INSERT INTO ast_connection (tenant_id, user_id, provider, account_email, scopes, refresh_enc, status) VALUES ($1,$2,'ics',$3,'read',$4,'active')
        ON CONFLICT (user_id, provider) DO UPDATE SET account_email=$3, refresh_enc=$4, status='active', last_error='', updated_at=now()`, [u.tenant_id, u.id, label, encrypt(url)]);
      icsCache.delete(u.id);
      await log(u.tenant_id, u.email, "connect.ics", label);
      return json(res, 200, { ok: true, count: evs.length, connections: await connectionsOut(u) });
    }
    if (p === "/api/connect/ics" && req.method === "DELETE") { await pool.query(`DELETE FROM ast_connection WHERE user_id=$1 AND provider='ics'`, [u.id]); icsCache.delete(u.id); await log(u.tenant_id, u.email, "disconnect.ics", ""); return json(res, 200, { ok: true, connections: await connectionsOut(u) }); }
    if (p === "/api/connect/google" && req.method === "DELETE") { await oauthDisconnect(u); return json(res, 200, { ok: true, connections: await connectionsOut(u) }); }

    if (p === "/api/prefs" && req.method === "PUT") {
      const b = await readBody(req); const allowed = ["nickname", "briefTime", "style"];
      for (const k of allowed) if (k in b) await pool.query(`INSERT INTO ast_user_pref (user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=$3, updated_at=now()`, [u.id, k, str(b[k], 200)]);
      if (b.displayName) await pool.query(`UPDATE ast_user SET display_name=$2 WHERE id=$1`, [u.id, str(b.displayName, 80)]);
      return json(res, 200, { ok: true });
    }

    /* ---- תדריך בוקר: נתונים מובנים (Timeline — רק אם יש קוד) ---- */
    if (p === "/api/brief" && req.method === "POST") {
      const [today, reminders] = await Promise.all([listTasks(u, "today"), listReminders(u, false)]);
      const n = nowParts();
      const soon = reminders.filter(r => new Date(r.remindAt) - Date.now() < 36 * 3600 * 1000);
      let calendar = null;
      const gc = await getConnection(u, "google");
      if ((gc && gc.status === "active" && GOOGLE_SCOPES.includes("calendar")) || await getConnection(u, "ics")) { const c = await toolCalendar(u, {}); calendar = c.error ? { error: c.message || c.error } : c.events; }
      const mail = await importantMail(u).catch(e => ({ error: String(e.message || e).slice(0, 120) }));
      const chores = (await listChores(u)).filter(c => c.nextDate && c.nextDate <= n.date);
      const ex = await expenseSummary(u);
      const lists = await listsOut(u);
      const shopping = lists.find(l => l.kind === "shopping");
      await log(u.tenant_id, u.email, "brief", (calendar ? "calendar" : "") + (mail && !mail.error ? ",mail" : ""));
      return json(res, 200, { ok: true, now: n, tasks: today, reminders: soon, calendar, mail, chores, expenses: { week: ex.week.total, month: ex.month.total }, shopping: shopping ? shopping.items.filter(i => !i.done).length : 0 });
    }
    /* ---- תכנון היום: המודל מציע לוח זמנים מהיומן, המשימות והתזכורות ---- */
    if (p === "/api/plan" && req.method === "POST") {
      const b = await readBody(req);
      const left = await usageLeft(u);
      if (left <= 0) return json(res, 429, { ok: false, error: "הגעת למגבלה היומית." });
      const data = await planData(u, b.date);
      const ask = b.note ? `תכנני לי את היום מחדש. מה השתנה: ${str(b.note, 500)}` : "תכנני לי את היום.";
      const r = await runAssistant(u, [{ role: "user", content: ask + "\nהנתונים (מתוך plan_day):\n" + JSON.stringify(data).slice(0, 12000) }]);
      await usageBump(u, r.usage).catch(() => {});
      await pool.query(`INSERT INTO ast_user_pref (user_id,key,value) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO UPDATE SET value=$3, updated_at=now()`, [u.id, "plan:" + data.date, r.answer.slice(0, 6000)]);
      await log(u.tenant_id, u.email, "plan", data.date);
      return json(res, 200, { ok: true, date: data.date, plan: r.answer, left: left - 1 });
    }
    if (p === "/api/plan" && req.method === "GET") {
      const d = url.searchParams.get("date") || nowParts().date;
      const r = await pool.query(`SELECT value FROM ast_user_pref WHERE user_id=$1 AND key=$2`, [u.id, "plan:" + d]);
      return json(res, 200, { ok: true, date: d, plan: r.rows[0] ? r.rows[0].value : "" });
    }

    /* ---- משק בית: רשימות, תורנויות, הוצאות ---- */
    if (p === "/api/household" && req.method === "GET") return json(res, 200, { ok: true, household: await householdOut(u) });
    if (p === "/api/household/join" && req.method === "POST") { const r = await householdJoin(u, (await readBody(req)).code); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, Object.assign({ ok: true, lists: await listsOut(u), chores: await listChores(u), expenses: await expenseSummary(u) }, r)); }
    if (p === "/api/household/leave" && req.method === "POST") return json(res, 200, Object.assign({ ok: true, lists: await listsOut(u), chores: await listChores(u), expenses: await expenseSummary(u) }, await householdLeave(u)));
    if (p === "/api/household" && req.method === "PUT") return json(res, 200, Object.assign({ ok: true }, await householdRename(u, (await readBody(req)).name)));
    if (p === "/api/household/create" && req.method === "POST") { await household(u, true); return json(res, 200, { ok: true, household: await householdOut(u) }); }
    if (p === "/api/lists" && req.method === "GET") return json(res, 200, { ok: true, lists: await listsOut(u) });
    if (p === "/api/lists/items" && req.method === "POST") { const r = await addListItems(u, await readBody(req), "ui"); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, lists: await listsOut(u), household: await householdOut(u) }); }
    if (p === "/api/lists/check" && req.method === "POST") { const r = await checkListItems(u, await readBody(req)); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, lists: await listsOut(u) }); }
    if (p === "/api/lists/clear" && req.method === "POST") { const r = await clearDoneItems(u, (await readBody(req)).list); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, lists: await listsOut(u) }); }
    if (p === "/api/lists/share" && req.method === "POST") { const b = await readBody(req); return json(res, 200, Object.assign({ ok: true }, await listShare(u, b.list, !!b.revoke))); }
    if (p === "/api/lists" && req.method === "DELETE") { const r = await deleteList(u, url.searchParams.get("name")); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, { ok: true, lists: await listsOut(u) }); }
    if (p === "/api/chores" && req.method === "GET") return json(res, 200, { ok: true, chores: await listChores(u) });
    if (p === "/api/chores" && req.method === "POST") { const r = await addChore(u, await readBody(req)); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, Object.assign({ ok: true, household: await householdOut(u) }, r)); }
    if (p.startsWith("/api/chores/") && req.method === "POST") { const r = await choreDone(u, { id: Number(p.split("/")[3]) }); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, Object.assign({ ok: true }, r)); }
    if (p.startsWith("/api/chores/") && req.method === "DELETE") return json(res, 200, Object.assign({ ok: true }, await deleteChore(u, p.split("/")[3])));
    if (p === "/api/expenses" && req.method === "GET") return json(res, 200, Object.assign({ ok: true }, await listExpenses(u, { fromDate: url.searchParams.get("from"), toDate: url.searchParams.get("to") })));
    if (p === "/api/expenses/summary" && req.method === "GET") return json(res, 200, { ok: true, expenses: await expenseSummary(u) });
    if (p === "/api/expenses" && req.method === "POST") { const r = await addExpense(u, await readBody(req), "ui"); return r.error ? json(res, 400, { ok: false, error: r.error }) : json(res, 200, Object.assign({ ok: true, expenses: await expenseSummary(u) }, r)); }
    if (p.startsWith("/api/expenses/") && req.method === "DELETE") { await deleteExpense(u, p.split("/")[3]); return json(res, 200, { ok: true, expenses: await expenseSummary(u) }); }

    /* ---- ניהול: כללי הפלטפורמה (מנהל/ת הפלטפורמה) · התאמות בית הספר (אחראי/ת מערכת) · משתמשים ---- */
    if (p === "/api/admin/platform-rules") {
      if (!isPlatformAdmin(u)) return json(res, 403, { ok: false, error: "אין הרשאה." });
      if (req.method === "GET") return json(res, 200, { ok: true, rules: (await pool.query(`SELECT * FROM ast_platform_rule ORDER BY sort_order,id`)).rows });
      if (req.method === "PUT") {
        const b = await readBody(req); const rules = Array.isArray(b.rules) ? b.rules : [];
        await pool.query("BEGIN");
        try {
          const keep = [];
          for (const [i, r] of rules.entries()) {
            const row = r.id ? await pool.query(`UPDATE ast_platform_rule SET kind=$2,title=$3,body=$4,sort_order=$5,enabled=$6,updated_by=$7,updated_at=now() WHERE id=$1 RETURNING id`, [r.id, str(r.kind, 20) || "rule", str(r.title, 120), str(r.body, 4000), (i + 1) * 10, r.enabled !== false, u.email])
                              : await pool.query(`INSERT INTO ast_platform_rule (kind,title,body,sort_order,enabled,updated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [str(r.kind, 20) || "rule", str(r.title, 120), str(r.body, 4000), (i + 1) * 10, r.enabled !== false, u.email]);
            if (row.rows[0]) keep.push(row.rows[0].id);
          }
          await pool.query(keep.length ? `DELETE FROM ast_platform_rule WHERE NOT (id = ANY($1::bigint[]))` : `DELETE FROM ast_platform_rule`, keep.length ? [keep] : []);
          await pool.query("COMMIT");
        } catch (e) { await pool.query("ROLLBACK"); throw e; }
        await log("", u.email, "platform.rules", rules.length);
        return json(res, 200, { ok: true, rules: (await pool.query(`SELECT * FROM ast_platform_rule ORDER BY sort_order,id`)).rows });
      }
    }
    if (p === "/api/admin/users") {
      if (!isSchoolAdmin(u)) return json(res, 403, { ok: false, error: "אין הרשאה." });
      if (req.method === "GET") {
        const r = await pool.query(`SELECT id,email,display_name,role,active,last_seen_at,created_at FROM ast_user WHERE tenant_id=$1 ORDER BY display_name`, [u.tenant_id]);
        const t = await pool.query(`SELECT seats, plan FROM ast_tenant WHERE id=$1`, [u.tenant_id]);
        return json(res, 200, { ok: true, users: r.rows, seats: t.rows[0].seats, plan: t.rows[0].plan });
      }
      if (req.method === "POST") {   // הוספה מראש של מורה (לפני הכניסה הראשונה) או שינוי תפקיד/מצב
        const b = await readBody(req); const em = str(b.email, 200).trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return json(res, 400, { ok: false, error: "כתובת מייל לא תקינה." });
        const role = "user";
        await pool.query(`INSERT INTO ast_user (tenant_id,email,display_name,role,active) VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id,email) DO UPDATE SET display_name=COALESCE(NULLIF($3,''),ast_user.display_name), role=CASE WHEN ast_user.role='platform_admin' THEN ast_user.role ELSE $4 END, active=$5`,
          [u.tenant_id, em, str(b.displayName, 80), role, b.active !== false]);
        await log(u.tenant_id, u.email, "user.upsert", em + ":" + (b.active !== false ? "on" : "off"));
        const r = await pool.query(`SELECT id,email,display_name,role,active,last_seen_at,created_at FROM ast_user WHERE tenant_id=$1 ORDER BY display_name`, [u.tenant_id]);
        return json(res, 200, { ok: true, users: r.rows });
      }
    }
    if (p === "/api/admin/log" && req.method === "GET") {
      if (!isSchoolAdmin(u)) return json(res, 403, { ok: false, error: "אין הרשאה." });
      const r = await pool.query(isPlatformAdmin(u) ? `SELECT * FROM ast_log ORDER BY id DESC LIMIT 200` : `SELECT * FROM ast_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 200`, isPlatformAdmin(u) ? [] : [u.tenant_id]);
      return json(res, 200, { ok: true, log: r.rows });
    }

    return json(res, 404, { ok: false, error: "not-found" });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (msg === "bad-json") return json(res, 400, { ok: false, error: "בקשה לא תקינה." });
    console.error(msg);
    return json(res, 500, { ok: false, error: "שגיאת שרת: " + msg.slice(0, 200) });
  }
});

server.listen(PORT, () => console.log(`Noni ${VERSION} · port ${PORT} · auth ${AUTH_MODE} · llm ${LLM_PROVIDER}/${LLM_PROVIDER === "gemini" ? GEMINI_MODEL + " @ " + GEMINI_REGION : MODEL}${LLM_PROVIDER === "vertex" ? " @ " + VERTEX_REGION : ""}`));
