const assert = require("assert");
const { parseICS, eventsBetween } = require("../ics");
const feed = `BEGIN:VCALENDAR\r
VERSION:2.0\r
X-WR-TIMEZONE:Asia/Jerusalem\r
BEGIN:VEVENT\r
UID:a1\r
DTSTART;TZID=Asia/Jerusalem:20261102T090000\r
DTEND;TZID=Asia/Jerusalem:20261102T100000\r
SUMMARY:פגישה\r
  שבועית\r
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6\r
EXDATE;TZID=Asia/Jerusalem:20261104T090000\r
BEGIN:VALARM\r
TRIGGER:-PT10M\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:a1\r
RECURRENCE-ID;TZID=Asia/Jerusalem:20261109T090000\r
DTSTART;TZID=Asia/Jerusalem:20261109T113000\r
DTEND;TZID=Asia/Jerusalem:20261109T123000\r
SUMMARY:פגישה שבועית (הוזזה)\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:b2\r
DTSTART;VALUE=DATE:20261103\r
DTEND;VALUE=DATE:20261104\r
SUMMARY:יום הולדת\r
RRULE:FREQ=YEARLY\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:c3\r
DTSTART:20261102T150000Z\r
DURATION:PT30M\r
SUMMARY:UTC call\\, team\r
LOCATION:Zoom\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:d4\r
DTSTART;TZID=America/New_York:20261101T080000\r
SUMMARY:monthly\r
RRULE:FREQ=MONTHLY;BYDAY=1SU;UNTIL=20270301T000000Z\r
END:VEVENT\r
END:VCALENDAR\r
`;
const ev = parseICS(feed, "Asia/Jerusalem");
assert.strictEqual(ev.length, 5);
assert.strictEqual(ev[0].title, "פגישה שבועית");
const d = s => Date.parse(s);
const r = eventsBetween(ev, d("2026-11-01T00:00:00Z"), d("2026-11-30T00:00:00Z"));
const fmt = ms => new Date(ms).toISOString();
const weekly = r.filter(x => x.uid === "a1").map(x => fmt(x.startMs));
// Jerusalem is UTC+2 in November. COUNT=6 counts the excluded instance: 2,4x,9(moved),11,16,18
assert.deepStrictEqual(weekly, ["2026-11-02T07:00:00.000Z", "2026-11-09T09:30:00.000Z", "2026-11-11T07:00:00.000Z", "2026-11-16T07:00:00.000Z", "2026-11-18T07:00:00.000Z"]);
assert.ok(r.find(x => x.uid === "b2" && x.allDay));
assert.strictEqual(r.find(x => x.uid === "c3").title, "UTC call, team");
assert.strictEqual(fmt(r.find(x => x.uid === "c3").endMs), "2026-11-02T15:30:00.000Z");
const m = eventsBetween(ev, d("2026-11-01T00:00:00Z"), d("2027-04-01T00:00:00Z")).filter(x => x.uid === "d4").map(x => fmt(x.startMs));
assert.deepStrictEqual(m, ["2026-11-01T13:00:00.000Z", "2026-12-06T13:00:00.000Z", "2027-01-03T13:00:00.000Z", "2027-02-07T13:00:00.000Z"]);
// next year's birthday
assert.ok(eventsBetween(ev, d("2027-11-02T00:00:00Z"), d("2027-11-05T00:00:00Z")).some(x => x.uid === "b2"));
console.log("ics ok");
