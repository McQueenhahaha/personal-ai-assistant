import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyPersonalMessage,
  classifySchoolMessage,
  collectDeadlines,
  compactLine,
  countGameSources,
  dateKeyInZone,
  dueSlots,
  extractDeadlinesFromMessage,
  extractYearFallback,
  formatPersonalSummary,
  formatSchoolSummary,
  gameKey,
  gamePrefix,
  localTimeToUtc,
  minutesInZone,
  monthNumber,
  parseClock,
  parseField,
  to24Hour,
  translateGameTitle,
  translatePersonalSubject,
  zonedParts
} from "../src/school-check.mjs";

const timeZone = "Etc/GMT-10";

function serializeDeadlines(deadlines) {
  return deadlines.map((deadline) => ({
    key: deadline.key,
    title: deadline.title,
    from: deadline.from,
    dueAt: deadline.dueAt.toISOString(),
    dueLocal: deadline.dueLocal,
    sourceDate: deadline.sourceDate
  }));
}

test("time zone and schedule helpers keep current behavior", () => {
  const date = new Date("2026-06-24T00:30:05Z");
  const now = new Date("2026-06-24T00:35:00Z");

  assert.deepEqual(zonedParts(date, timeZone), {
    year: 2026,
    month: 6,
    day: 24,
    hour: 10,
    minute: 30,
    second: 5
  });
  assert.equal(dateKeyInZone(date, timeZone), "2026-06-24");
  assert.equal(minutesInZone(date, timeZone), 630);
  assert.deepEqual(parseClock("9:05"), { hour: 9, minute: 5, total: 545, label: "09:05" });
  assert.equal(parseClock("24:00"), null);
  assert.equal(parseClock("bad"), null);
  assert.deepEqual(
    dueSlots({ now, timeZone, times: ["10:30"], graceMinutes: 25, state: { slots: {} } }),
    [{ key: "2026-06-24 10:30", label: "10:30" }]
  );
  assert.deepEqual(
    dueSlots({
      now,
      timeZone,
      times: ["10:30"],
      graceMinutes: 25,
      state: { slots: { "2026-06-24 10:30": "done" } }
    }),
    []
  );
});

test("text and game summary helpers keep current behavior", () => {
  assert.equal(parseField("- From: Alice\n- Subject: Test", "From"), "Alice");
  assert.equal(parseField("- Subject: Test", "From"), "");
  assert.equal(compactLine("  a\n\t b   c  "), "a b c");
  assert.equal(gameKey({ game: "War Thunder", title: "Update", link: "HTTPS://X" }), "war thunder|update|https://x");
  assert.deepEqual(
    countGameSources([
      { game: "War Thunder", sourceType: "official-site" },
      { game: "War Thunder", sourceType: "official-site" },
      {}
    ]),
    {
      "War Thunder:official-site": 2,
      "unknown:unknown": 1
    }
  );
  assert.equal(translateGameTitle("Development Sound Mods - Bilibili"), "开发日志：声音 Mod");
  assert.equal(gamePrefix({ sourceType: "official-site", game: "War Thunder" }), "战雷官方");
  assert.equal(gamePrefix({ game: "Escape from Tarkov" }), "塔科夫");
});

test("school and personal classifiers keep current labels", () => {
  assert.equal(classifySchoolMessage({ subject: "CES survey", body: "" }), "问卷/反馈");
  assert.equal(classifySchoolMessage({ subject: "Assignment 1 due", body: "" }), "作业/测验");
  assert.deepEqual(classifyPersonalMessage({ subject: "Security alert", from: "Google" }), {
    kind: "账号安全",
    important: true
  });
  assert.deepEqual(classifyPersonalMessage({ subject: "Uber receipt", from: "Uber" }), {
    kind: "低优先级",
    important: false
  });
  assert.equal(translatePersonalSubject("Security alert"), "Google 安全提醒");
  assert.equal(translatePersonalSubject("Fw: hello"), "转发：hello");
});

test("personal summary formatting keeps the full current string", () => {
  assert.equal(
    formatPersonalSummary(
      [
        {
          subject: "Security alert",
          from: "Google",
          date: "2026-06-24",
          labels: "INBOX"
        }
      ],
      { slotLabel: "10:30", timeZone, skippedLowPriority: 2 }
    ),
    [
      "个人 Gmail 检查（Etc/GMT-10 10:30）",
      "",
      "- [账号安全] Google 安全提醒｜Google｜2026-06-24",
      "- 已略过 2 封收据/促销等低优先级新邮件。",
      "",
      "时区：Etc/GMT-10"
    ].join("\n")
  );
});

test("school summary formatting keeps empty and capped output strings", () => {
  assert.equal(
    formatSchoolSummary([], { slotLabel: "手动", timeZone }),
    [
      "学校检查（Etc/GMT-10 手动）",
      "",
      "- 暂无新的学校事项。"
    ].join("\n")
  );

  const messages = Array.from({ length: 9 }, (_, index) => ({
    subject: index === 0 ? "CES survey" : `Assignment ${index} due`,
    body: index === 0 ? "" : "Submit soon",
    date: `2026-06-${String(10 + index).padStart(2, "0")}`,
    from: "School"
  }));

  assert.equal(
    formatSchoolSummary(messages, { slotLabel: "10:30", timeZone }),
    [
      "学校检查（Etc/GMT-10 10:30）",
      "",
      "- [问卷/反馈] CES survey｜2026-06-10",
      "- [作业/测验] Assignment 1 due｜2026-06-11",
      "- [作业/测验] Assignment 2 due｜2026-06-12",
      "- [作业/测验] Assignment 3 due｜2026-06-13",
      "- [作业/测验] Assignment 4 due｜2026-06-14",
      "- [作业/测验] Assignment 5 due｜2026-06-15",
      "- [作业/测验] Assignment 6 due｜2026-06-16",
      "- [作业/测验] Assignment 7 due｜2026-06-17",
      "",
      "时区：Etc/GMT-10"
    ].join("\n")
  );
});

test("deadline date helpers keep current behavior", () => {
  const now = new Date("2026-06-20T00:00:00Z");

  assert.equal(monthNumber("Sept"), 9);
  assert.equal(monthNumber("bad"), undefined);
  assert.deepEqual([to24Hour(12, "am"), to24Hour(12, "pm"), to24Hour(7, "pm")], [0, 12, 19]);
  assert.equal(
    localTimeToUtc({ year: 2026, month: 6, day: 24, hour: 10, minute: 30 }, timeZone).toISOString(),
    "2026-06-24T00:30:00.000Z"
  );
  assert.equal(extractYearFallback({ date: "Mon, 1 Jun 2025 10:00:00 +1000" }, now, timeZone), 2025);
  assert.equal(extractYearFallback({ date: "No year" }, now, timeZone), 2026);
});

test("deadline extraction and collection keep full current objects", () => {
  const now = new Date("2026-06-20T00:00:00Z");
  const forwardMessage = {
    key: "school|a",
    subject: "Assignment due",
    from: "School Canvas",
    date: "Mon, 1 Jun 2026 10:00:00 +1000",
    body: "Assignment due June 24, 2026 at 11:30 pm"
  };
  const reverseMessage = {
    key: "school|b",
    subject: "Quiz deadline",
    from: "School Canvas",
    date: "Mon, 1 Jun 2026 10:00:00 +1000",
    body: "24 June 2026 at 23:30 deadline"
  };
  const duplicateDeadlineMessage = {
    key: "school|dup",
    subject: "Project deadline",
    from: "School Canvas",
    date: "Mon, 1 Jun 2026 10:00:00 +1000",
    body: "Project due June 25, 2026 at 10:15 am"
  };

  assert.deepEqual(serializeDeadlines(extractDeadlinesFromMessage(forwardMessage, { now, timeZone })), [
    {
      key: "school|a|2026-06-24T13:30:00.000Z",
      title: "Assignment due",
      from: "School Canvas",
      dueAt: "2026-06-24T13:30:00.000Z",
      dueLocal: "2026-06-24 23:30",
      sourceDate: "Mon, 1 Jun 2026 10:00:00 +1000"
    }
  ]);
  assert.deepEqual(serializeDeadlines(extractDeadlinesFromMessage(reverseMessage, { now, timeZone })), [
    {
      key: "school|b|2026-06-24T13:30:00.000Z",
      title: "Quiz deadline",
      from: "School Canvas",
      dueAt: "2026-06-24T13:30:00.000Z",
      dueLocal: "2026-06-24 23:30",
      sourceDate: "Mon, 1 Jun 2026 10:00:00 +1000"
    }
  ]);
  assert.deepEqual(
    serializeDeadlines(collectDeadlines([
      duplicateDeadlineMessage,
      { ...duplicateDeadlineMessage, subject: "Duplicate deadline" },
      forwardMessage
    ], { now, timeZone })),
    [
      {
        key: "school|a|2026-06-24T13:30:00.000Z",
        title: "Assignment due",
        from: "School Canvas",
        dueAt: "2026-06-24T13:30:00.000Z",
        dueLocal: "2026-06-24 23:30",
        sourceDate: "Mon, 1 Jun 2026 10:00:00 +1000"
      },
      {
        key: "school|dup|2026-06-25T00:15:00.000Z",
        title: "Duplicate deadline",
        from: "School Canvas",
        dueAt: "2026-06-25T00:15:00.000Z",
        dueLocal: "2026-06-25 10:15",
        sourceDate: "Mon, 1 Jun 2026 10:00:00 +1000"
      }
    ]
  );
});
