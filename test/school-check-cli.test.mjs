import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeCliRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-school-cli-"));
  fs.cpSync(path.resolve("src"), path.join(root, "src"), { recursive: true });
  const schoolDrop = path.join(root, "fixtures", "school");
  const personalDrop = path.join(root, "fixtures", "personal");
  fs.mkdirSync(schoolDrop, { recursive: true });
  fs.mkdirSync(personalDrop, { recursive: true });
  fs.writeFileSync(
    path.join(schoolDrop, "campus-update.eml"),
    [
      "Subject: Campus update for CLI smoke",
      "From: School Test <test@example.edu>",
      "Date: Wed, 24 Jun 2026 10:00:00 +1000",
      "",
      "This is a smoke fixture."
    ].join("\n"),
    "utf8"
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, schoolDrop, personalDrop };
}

function runSchoolCheck({ root, schoolDrop, personalDrop, args }) {
  const env = {
    ...process.env,
    SCHOOL_MAIL_DROP_DIR: schoolDrop,
    PERSONAL_MAIL_DROP_DIR: personalDrop,
    SCHOOL_CHECK_TIMES: "99:99",
    SCHOOL_CHECK_GRACE_MINUTES: "0",
    SCHOOL_TIMEZONE: "Etc/GMT-10",
    MAIL_DROP_MAX_FILES: "5"
  };
  delete env.TELEGRAM_BOT_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/school-check.mjs", ...args], {
      cwd: root,
      env
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function readOnlyRunSummary(root) {
  const logsDir = path.join(root, "data", "logs");
  const logs = fs.readdirSync(logsDir).filter((name) => /^school-check-.*\.json$/.test(name));
  assert.equal(logs.length, 1);
  const summary = JSON.parse(fs.readFileSync(path.join(logsDir, logs[0]), "utf8"));
  const relativeStatePath = path.relative(root, summary.stateFile);
  assert.equal(relativeStatePath.startsWith(".."), false);
  return summary;
}

function writeDueSoonFixture({ root, schoolDrop }, now) {
  const dueAt = new Date(now.getTime() + 30 * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Etc/GMT-10",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).formatToParts(dueAt).map((part) => [part.type, part.value]));
  fs.writeFileSync(
    path.join(schoolDrop, "due-soon.eml"),
    [
      "Subject: Assignment due soon",
      "From: School Canvas <canvas@example.edu>",
      "Date: Mon, 3 Aug 2026 10:00:00 +1000",
      "",
      `Assignment due ${parts.month} ${parts.day}, ${parts.year} at ${parts.hour}:${parts.minute} ${parts.dayPeriod.toLowerCase()}`
    ].join("\n"),
    "utf8"
  );

  const stateDir = path.join(root, "data", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "school-check-state.json"), JSON.stringify({
    slots: {},
    seenMessageKeys: [],
    seenPersonalKeys: [],
    seenGameKeys: [],
    remindedDeadlineKeys: [],
    schoolCatchup: null,
    gameCatchup: null,
    lastDigestKey: "previous-content",
    lastDigestSentAt: now.toISOString()
  }), "utf8");
}

test("school-check CLI dry-run check-only writes a temp run summary without Telegram", async (t) => {
  const context = makeCliRoot(t);

  const result = await runSchoolCheck({
    ...context,
    args: ["--dry-run", "--check-only"]
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /"timezone": "Etc\/GMT-10"/);
  assert.match(result.stdout, /"telegramMessagesSent": 0/);

  const summary = readOnlyRunSummary(context.root);
  assert.deepEqual(summary.dueSlots, []);
  assert.equal(summary.exported, false);
  assert.equal(summary.messages, 1);
  assert.equal(summary.telegramMessagesSent, 0);
});

test("school-check CLI force-school dry-run prints the school summary and writes only temp logs", async (t) => {
  const context = makeCliRoot(t);

  const result = await runSchoolCheck({
    ...context,
    args: ["--dry-run", "--check-only", "--force-school"]
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /Campus update for CLI smoke/);
  assert.match(result.stdout, /"exported": false/);
  assert.match(result.stdout, /"telegramMessagesSent": 1/);

  const summary = readOnlyRunSummary(context.root);
  assert.deepEqual(summary.dueSlots, []);
  assert.equal(summary.exported, false);
  assert.equal(summary.messages, 1);
  assert.equal(summary.telegramMessagesSent, 1);
});

test("deadline reminder bypasses merged digest throttling", async (t) => {
  const context = makeCliRoot(t);
  writeDueSoonFixture(context, new Date());

  const result = await runSchoolCheck({
    ...context,
    args: ["--dry-run", "--check-only", "--force-school"]
  });

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /学校临期提醒/);
  assert.match(result.stdout, /摘要未发送：too-soon/);
  assert.doesNotMatch(result.stdout, /📬/);

  const summary = readOnlyRunSummary(context.root);
  assert.equal(summary.remindersSent, 1);
  assert.equal(summary.telegramMessagesSent, 1);
  assert.equal(summary.digestSendReason, "too-soon");
});
