/* נוני — פענוח ICS (יומן אפל / כל יומן) — קריאה בלבד, בלי תלויות.
   תומך: קיפול שורות, DTSTART/DTEND עם TZID / Z / מקומי / VALUE=DATE, DURATION,
   RRULE (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY), EXDATE, RECURRENCE-ID. */
"use strict";
const WIN_TZ = { "Israel Standard Time": "Asia/Jerusalem", "Pacific Standard Time": "America/Los_Angeles", "Eastern Standard Time": "America/New_York", "GMT Standard Time": "Europe/London", "Central European Standard Time": "Europe/Berlin", "W. Europe Standard Time": "Europe/Berlin", "UTC": "UTC" };
function normTz(tz, def) {
  if (!tz) return def;
  tz = String(tz).replace(/^"|"$/g, "").replace(/^\/[^/]*\/[^/]*\//, "");
  if (WIN_TZ[tz]) return WIN_TZ[tz];
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch (e) { return def; }
}
function tzOffsetMs(tz, utcMs) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
/* שעון קיר באזור זמן ← UTC */
function wallToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo, d, h, mi, s);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}
function unfold(text) { return String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n"); }
function parseLine(line) {
  const i = line.indexOf(":"); if (i < 0) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = head.split(";"); const name = parts.shift().toUpperCase();
  const params = {}; for (const p of parts) { const j = p.indexOf("="); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1); }
  return { name, params, value };
}
function unesc(v) { return String(v || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim(); }
/* מחזיר {ms, allDay, wall:[y,mo,d,h,mi,s], tz} */
function parseDate(value, params, defTz) {
  const m = String(value).trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (!m[4] || (params && params.VALUE === "DATE")) return { allDay: true, wall: [y, mo, d, 0, 0, 0], tz: defTz, ms: wallToUtc(y, mo, d, 0, 0, 0, defTz) };
  const h = +m[4], mi = +m[5], s = +(m[6] || 0);
  if (m[7]) { const ms = Date.UTC(y, mo, d, h, mi, s); return { allDay: false, utc: true, ms, tz: "UTC", wall: [y, mo, d, h, mi, s] }; }
  const tz = normTz(params && params.TZID, defTz);
  return { allDay: false, tz, wall: [y, mo, d, h, mi, s], ms: wallToUtc(y, mo, d, h, mi, s, tz) };
}
function parseDuration(v) {
  const m = String(v || "").match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
  return m[1] === "-" ? -ms : ms;
}
function parseICS(text, defTz) {
  defTz = defTz || "Asia/Jerusalem";
  const lines = unfold(text);
  const events = []; let cur = null, depth = 0, calTz = null;
  for (const raw of lines) {
    const l = parseLine(raw); if (!l) continue;
    if (l.name === "X-WR-TIMEZONE" && !cur) calTz = normTz(l.value.trim(), null);
    if (l.name === "BEGIN" && l.value.trim().toUpperCase() === "VEVENT") { cur = { exdates: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (l.name === "BEGIN") { depth++; continue; }       // VALARM וכו'
    if (l.name === "END" && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (l.name === "END" && l.value.trim().toUpperCase() === "VEVENT") { events.push(cur); cur = null; continue; }
    const tz = calTz || defTz;
    switch (l.name) {
      case "UID": cur.uid = l.value.trim(); break;
      case "SUMMARY": cur.title = unesc(l.value); break;
      case "LOCATION": cur.location = unesc(l.value); break;
      case "DESCRIPTION": cur.description = unesc(l.value).slice(0, 500); break;
      case "STATUS": cur.status = l.value.trim().toUpperCase(); break;
      case "DTSTART": cur.start = parseDate(l.value, l.params, tz); break;
      case "DTEND": cur.end = parseDate(l.value, l.params, tz); break;
      case "DURATION": cur.duration = parseDuration(l.value.trim()); break;
      case "RRULE": cur.rrule = Object.fromEntries(l.value.trim().split(";").map(x => x.split("=")).map(([k, v]) => [k.toUpperCase(), v])); break;
      case "EXDATE": for (const v of l.value.split(",")) { const d = parseDate(v, l.params, tz); if (d) cur.exdates.push(d.ms); } break;
      case "RECURRENCE-ID": cur.recurrenceId = parseDate(l.value, l.params, tz); break;
    }
  }
  return events.filter(e => e.start);
}
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/* מופעים של אירוע חוזר בטווח [fromMs, toMs) — לפי שעון קיר באזור הזמן של האירוע (שומר על שעה קבועה במעבר שעון) */
function occurrences(ev, fromMs, toMs, max) {
  max = max || 500; const toMs_ = toMs;
  const dur = ev.end ? ev.end.ms - ev.start.ms : (ev.duration || (ev.start.allDay ? 86400000 : 0));
  const out = [];
  const push = ms => { if (ms + Math.max(dur, 1) > fromMs && ms < toMs && !ev.exdates.includes(ms)) out.push({ ms, endMs: ms + dur }); };
  if (!ev.rrule) { push(ev.start.ms); return out; }
  const r = ev.rrule, freq = (r.FREQ || "").toUpperCase(), interval = Math.max(1, +r.INTERVAL || 1);
  const count = r.COUNT ? +r.COUNT : Infinity;
  const until = r.UNTIL ? (parseDate(r.UNTIL, {}, ev.start.tz) || {}).ms : Infinity;
  const [y0, mo0, d0, h, mi, s] = ev.start.wall;
  const tz = ev.start.tz;
  const wall = (y, mo, d) => ev.start.utc ? Date.UTC(y, mo, d, h, mi, s) : wallToUtc(y, mo, d, h, mi, s, tz);
  const byday = r.BYDAY ? r.BYDAY.split(",").map(x => { const m = x.match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/); return m ? { n: m[1] ? +m[1] : 0, wd: DAYS.indexOf(m[2]) } : null; }).filter(Boolean) : null;
  const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null;
  let n = 0, guard = 0;
  const emit = ms => { if (ms < ev.start.ms) return true; if (ms > until || n >= count) return false; n++; push(ms); return true; };
  const dim = (y, mo) => new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  if (freq === "DAILY") {
    for (let i = 0; guard++ < 20000; i += interval) {
      const dt = new Date(Date.UTC(y0, mo0, d0 + i));
      const ms = wall(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
      if (ms >= toMs_ || !emit(ms) || out.length >= max) break;
    }
  } else if (freq === "WEEKLY") {
    const wds = byday ? byday.map(b => b.wd).sort() : [new Date(Date.UTC(y0, mo0, d0)).getUTCDay()];
    const startDow = new Date(Date.UTC(y0, mo0, d0)).getUTCDay();
    for (let w = 0; guard++ < 5000; w += interval) {
      let stop = false;
      for (const wd of wds) {
        const dt = new Date(Date.UTC(y0, mo0, d0 - startDow + w * 7 + wd));
        const ms = wall(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
        if (ms >= toMs_ || !emit(ms) || out.length >= max) { stop = true; break; }
      }
      if (stop) break;
    }
  } else if (freq === "MONTHLY" || freq === "YEARLY") {
    const step = freq === "YEARLY" ? 12 * interval : interval;
    for (let k = 0; guard++ < 3000; k += step) {
      const base = new Date(Date.UTC(y0, mo0 + k, 1)); const y = base.getUTCFullYear(), mo = base.getUTCMonth();
      let days = [];
      if (bymd) days = bymd.map(x => x < 0 ? dim(y, mo) + x + 1 : x);
      else if (byday && freq === "MONTHLY") {
        for (const b of byday) {
          const all = []; for (let d = 1; d <= dim(y, mo); d++) if (new Date(Date.UTC(y, mo, d)).getUTCDay() === b.wd) all.push(d);
          if (b.n > 0) { if (all[b.n - 1]) days.push(all[b.n - 1]); } else if (b.n < 0) { if (all[all.length + b.n]) days.push(all[all.length + b.n]); } else days.push(...all);
        }
      } else days = [d0];
      if (freq === "YEARLY" && !bymd && !byday && mo !== mo0) continue;
      let stop = false;
      for (const d of days.filter(d => d >= 1 && d <= dim(y, mo)).sort((a, b) => a - b)) {
        const ms = wall(y, mo, d);
        if (ms >= toMs_ || !emit(ms) || out.length >= max) { stop = true; break; }
      }
      if (stop) break;
    }
  } else push(ev.start.ms);
  return out;
}
/* כל האירועים בטווח, כולל מופעים חוזרים, החרגות ושינויים בודדים (RECURRENCE-ID). ממוין לפי התחלה. */
function eventsBetween(events, fromMs, toMs) {
  const overrides = new Map();
  for (const e of events) if (e.recurrenceId) overrides.set(e.uid + "|" + e.recurrenceId.ms, e);
  const out = [];
  for (const e of events) {
    if (e.status === "CANCELLED" && !e.recurrenceId) continue;
    if (e.recurrenceId) { if (e.status !== "CANCELLED") for (const o of occurrences(Object.assign({}, e, { rrule: null }), fromMs, toMs)) out.push(mk(e, o)); continue; }
    for (const o of occurrences(e, fromMs, toMs)) { if (overrides.has(e.uid + "|" + o.ms)) continue; out.push(mk(e, o)); }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
  function mk(e, o) { return { uid: e.uid || "", title: e.title || "(ללא כותרת)", location: e.location || "", allDay: !!e.start.allDay, startMs: o.ms, endMs: o.endMs }; }
}
module.exports = { parseICS, eventsBetween, wallToUtc };
