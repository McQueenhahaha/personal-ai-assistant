import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvasIcs } from "../src/canvas/feed.mjs";

const ics = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:event-assignment-date-1",
  "SUMMARY:Essay draft [COSC1111]",
  "DTSTART;VALUE=DATE;VALUE=DATE:20260701",
  "URL:https://canvas.example.test/date",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-assignment-utc-1",
  "SUMMARY:Lab 2 [ISYS2222]",
  "DTSTART:20260702T135000Z",
  "URL;VALUE=URI:https://canvas.example.test/utc",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-assignment-folded-1",
  "SUMMARY:Folded",
  "  assignment title [COSC3333]",
  "DTSTART:20260703T090500Z",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-calendar-note-1",
  "SUMMARY:Lecture [COSC4444]",
  "DTSTART:20260704T090000Z",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

test("parseCanvasIcs parses Canvas assignment events only", () => {
  const assignments = parseCanvasIcs(ics);

  assert.deepEqual(assignments.map(({ uid }) => uid), [
    "event-assignment-date-1",
    "event-assignment-utc-1",
    "event-assignment-folded-1"
  ]);
});

test("parseCanvasIcs extracts title, course code, URL, and unfolded summary", () => {
  const assignments = parseCanvasIcs(ics);

  assert.equal(assignments[0].title, "Essay draft");
  assert.equal(assignments[0].courseCode, "COSC1111");
  assert.equal(assignments[0].url, "https://canvas.example.test/date");

  assert.equal(assignments[1].title, "Lab 2");
  assert.equal(assignments[1].courseCode, "ISYS2222");
  assert.equal(assignments[1].url, "https://canvas.example.test/utc");

  assert.equal(assignments[2].title, "Folded assignment title");
  assert.equal(assignments[2].courseCode, "COSC3333");
  assert.equal(assignments[2].url, "");
});

test("parseCanvasIcs parses date-only due in local time and UTC due exactly", () => {
  const assignments = parseCanvasIcs(ics);
  const dateOnlyDue = new Date(2026, 6, 1, 23, 59, 59).getTime();

  assert.equal(assignments[0].dueMs, dateOnlyDue);
  assert.equal(new Date(assignments[1].dueMs).toISOString(), "2026-07-02T13:50:00.000Z");
  assert.equal(new Date(assignments[2].dueMs).toISOString(), "2026-07-03T09:05:00.000Z");
});
