import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseGmailSnapshot,
  parseOutlookSnapshot,
  personalMessagesFromDrops,
  schoolMessagesFromDrops
} from "../src/school-check.mjs";

const outlookSnapshotLines = [
  "# Outlook Snapshot",
  "",
  "## Assignment 1 due",
  "- From: School Canvas <canvas@example.edu>",
  "- Received: Wed, 24 Jun 2026 10:00:00 +1000",
  "",
  "Submit your assignment.",
  "",
  "## Missing fields notice",
  "",
  "Body without metadata."
];

const gmailSnapshotLines = [
  "# Gmail Snapshot",
  "",
  "```text",
  "ID\tDate\tFrom\tSubject\tLabels",
  "g-1\t2026-06-24T01:00:00Z\tGoogle Alerts\tSecurity alert\tINBOX",
  "g-2\t2026-06-24T02:00:00Z\tDraft Sender\tDraft subject\tDRAFT,INBOX",
  "bad\tmissing",
  "g-3\t2026-06-23T23:00:00Z\tSchool Updates\tCampus note\tINBOX,IMPORTANT",
  "```"
];

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-school-mail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFixture(file, lines, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Array.isArray(lines) ? lines.join("\n") : lines, "utf8");
  if (mtime) {
    fs.utimesSync(file, mtime, mtime);
  }
}

function withMailDropEnvAndCwd({ root, schoolDrop, personalDrop }, fn) {
  const oldCwd = process.cwd();
  const oldSchoolDrop = process.env.SCHOOL_MAIL_DROP_DIR;
  const oldPersonalDrop = process.env.PERSONAL_MAIL_DROP_DIR;
  process.env.SCHOOL_MAIL_DROP_DIR = schoolDrop;
  process.env.PERSONAL_MAIL_DROP_DIR = personalDrop;
  process.chdir(root);

  try {
    return fn();
  } finally {
    process.chdir(oldCwd);
    if (oldSchoolDrop === undefined) {
      delete process.env.SCHOOL_MAIL_DROP_DIR;
    } else {
      process.env.SCHOOL_MAIL_DROP_DIR = oldSchoolDrop;
    }
    if (oldPersonalDrop === undefined) {
      delete process.env.PERSONAL_MAIL_DROP_DIR;
    } else {
      process.env.PERSONAL_MAIL_DROP_DIR = oldPersonalDrop;
    }
  }
}

test("Outlook snapshot parsing keeps normal, empty, and missing-field behavior", (t) => {
  const root = makeTempRoot(t);
  const snapshotFile = path.join(root, "fixtures", "outlook-school-snapshot-20260624.md");
  const emptyFile = path.join(root, "fixtures", "empty-outlook.md");
  writeFixture(snapshotFile, outlookSnapshotLines);
  writeFixture(emptyFile, []);

  assert.deepEqual(parseOutlookSnapshot(snapshotFile), [
    {
      category: "school",
      file: snapshotFile,
      subject: "Assignment 1 due",
      from: "School Canvas <canvas@example.edu>",
      date: "Wed, 24 Jun 2026 10:00:00 +1000",
      body: "Submit your assignment.",
      key: "wed, 24 jun 2026 10:00:00 +1000|school canvas <canvas@example.edu>|assignment 1 due"
    },
    {
      category: "school",
      file: snapshotFile,
      subject: "Missing fields notice",
      from: "unknown sender",
      date: "",
      body: "Body without metadata.",
      key: "|unknown sender|missing fields notice"
    }
  ]);
  assert.deepEqual(parseOutlookSnapshot(emptyFile), []);
});

test("Gmail snapshot parsing keeps code block, raw table, draft, and malformed-row behavior", (t) => {
  const root = makeTempRoot(t);
  const snapshotFile = path.join(root, "fixtures", "gmail-snapshot-20260624.md");
  const rawTableFile = path.join(root, "fixtures", "gmail-raw.tsv");
  const emptyFile = path.join(root, "fixtures", "empty-gmail.md");
  writeFixture(snapshotFile, gmailSnapshotLines);
  writeFixture(rawTableFile, [
    "ID\tDate\tFrom\tSubject\tLabels",
    "raw-1\t2026-06-22T08:00:00Z\tRaw Sender\tRaw subject\tINBOX"
  ]);
  writeFixture(emptyFile, []);

  assert.deepEqual(parseGmailSnapshot(snapshotFile), [
    {
      category: "personal",
      file: snapshotFile,
      id: "g-1",
      date: "2026-06-24T01:00:00Z",
      from: "Google Alerts",
      subject: "Security alert",
      labels: "INBOX",
      key: "gmail|g-1"
    },
    {
      category: "personal",
      file: snapshotFile,
      id: "g-3",
      date: "2026-06-23T23:00:00Z",
      from: "School Updates",
      subject: "Campus note",
      labels: "INBOX,IMPORTANT",
      key: "gmail|g-3"
    }
  ]);
  assert.deepEqual(parseGmailSnapshot(rawTableFile), [
    {
      category: "personal",
      file: rawTableFile,
      id: "raw-1",
      date: "2026-06-22T08:00:00Z",
      from: "Raw Sender",
      subject: "Raw subject",
      labels: "INBOX",
      key: "gmail|raw-1"
    }
  ]);
  assert.deepEqual(parseGmailSnapshot(emptyFile), []);
});

test("school mail drops keep Outlook compatibility, key dedupe, and current string sorting", (t) => {
  const root = makeTempRoot(t);
  const schoolDrop = path.join(root, "school-drop");
  const personalDrop = path.join(root, "personal-drop");
  writeFixture(
    path.join(schoolDrop, "outlook-school-snapshot-20260624.md"),
    outlookSnapshotLines,
    new Date("2026-06-24T00:00:00.000Z")
  );
  writeFixture(
    path.join(schoolDrop, "duplicate-school.eml"),
    [
      "Subject: Assignment 1 due",
      "From: School Canvas <canvas@example.edu>",
      "Date: Wed, 24 Jun 2026 10:00:00 +1000",
      "",
      "Duplicate body."
    ],
    new Date("2026-06-24T00:05:00.000Z")
  );
  writeFixture(
    path.join(schoolDrop, "newer-school.eml"),
    [
      "Subject: Later school update",
      "From: School Updates <updates@example.edu>",
      "Date: Thu, 25 Jun 2026 09:00:00 +1000",
      "",
      "Later body."
    ],
    new Date("2026-06-24T00:10:00.000Z")
  );
  writeFixture(
    path.join(schoolDrop, "empty-subject.eml"),
    [
      "From: No Subject <nosubject@example.edu>",
      "Date: Fri, 26 Jun 2026 09:00:00 +1000",
      "",
      "No subject header falls back to filename."
    ],
    new Date("2026-06-24T00:15:00.000Z")
  );

  const messages = withMailDropEnvAndCwd({ root, schoolDrop, personalDrop }, () => schoolMessagesFromDrops(20));

  // Ordering is now Date.parse timestamp descending, fixing mixed string-date sorting.
  assert.deepEqual(messages, [
    {
      category: "school",
      file: path.join(schoolDrop, "empty-subject.eml"),
      subject: "empty-subject.eml",
      from: "No Subject <nosubject@example.edu>",
      date: "Fri, 26 Jun 2026 09:00:00 +1000",
      modifiedAt: "2026-06-24T00:15:00.000Z",
      body: [
        "From: No Subject <nosubject@example.edu>",
        "Date: Fri, 26 Jun 2026 09:00:00 +1000",
        "",
        "No subject header falls back to filename."
      ].join("\n"),
      key: "fri, 26 jun 2026 09:00:00 +1000|no subject <nosubject@example.edu>|empty-subject.eml"
    },
    {
      category: "school",
      file: path.join(schoolDrop, "newer-school.eml"),
      subject: "Later school update",
      from: "School Updates <updates@example.edu>",
      date: "Thu, 25 Jun 2026 09:00:00 +1000",
      modifiedAt: "2026-06-24T00:10:00.000Z",
      body: [
        "Subject: Later school update",
        "From: School Updates <updates@example.edu>",
        "Date: Thu, 25 Jun 2026 09:00:00 +1000",
        "",
        "Later body."
      ].join("\n"),
      key: "thu, 25 jun 2026 09:00:00 +1000|school updates <updates@example.edu>|later school update"
    },
    {
      category: "school",
      file: path.join(schoolDrop, "duplicate-school.eml"),
      subject: "Assignment 1 due",
      from: "School Canvas <canvas@example.edu>",
      date: "Wed, 24 Jun 2026 10:00:00 +1000",
      modifiedAt: "2026-06-24T00:05:00.000Z",
      body: [
        "Subject: Assignment 1 due",
        "From: School Canvas <canvas@example.edu>",
        "Date: Wed, 24 Jun 2026 10:00:00 +1000",
        "",
        "Duplicate body."
      ].join("\n"),
      key: "wed, 24 jun 2026 10:00:00 +1000|school canvas <canvas@example.edu>|assignment 1 due"
    },
    {
      category: "school",
      file: path.join(schoolDrop, "outlook-school-snapshot-20260624.md"),
      subject: "Missing fields notice",
      from: "unknown sender",
      date: "",
      body: "Body without metadata.",
      key: "|unknown sender|missing fields notice"
    }
  ]);
});

test("personal mail drops keep Gmail compatibility, draft and connector skips, dedupe, and sorting", (t) => {
  const root = makeTempRoot(t);
  const schoolDrop = path.join(root, "school-drop");
  const personalDrop = path.join(root, "personal-drop");
  writeFixture(
    path.join(personalDrop, "gmail-snapshot-20260624.md"),
    gmailSnapshotLines,
    new Date("2026-06-24T01:00:00.000Z")
  );
  writeFixture(
    path.join(personalDrop, "duplicate-personal.eml"),
    [
      "Subject: Bank alert",
      "From: Bank <bank@example.com>",
      "Date: Thu, 25 Jun 2026 08:00:00 +1000",
      "",
      "Duplicate account notice."
    ],
    new Date("2026-06-24T01:05:00.000Z")
  );
  writeFixture(
    path.join(personalDrop, "newer-personal.eml"),
    [
      "Subject: Bank alert",
      "From: Bank <bank@example.com>",
      "Date: Thu, 25 Jun 2026 08:00:00 +1000",
      "",
      "Account notice."
    ],
    new Date("2026-06-24T01:10:00.000Z")
  );
  writeFixture(
    path.join(personalDrop, "connector-subject.eml"),
    [
      "Subject: Gmail Inbox Snapshot 2026-06-24",
      "From: Human Sender <human@example.com>",
      "Date: Thu, 25 Jun 2026 07:00:00 +1000",
      "",
      "Connector noise subject."
    ],
    new Date("2026-06-24T01:15:00.000Z")
  );
  writeFixture(
    path.join(personalDrop, "connector-from.eml"),
    [
      "Subject: Ordinary subject",
      "From: Codex Gmail Connector <connector@example.com>",
      "Date: Thu, 25 Jun 2026 06:00:00 +1000",
      "",
      "Connector noise sender."
    ],
    new Date("2026-06-24T01:20:00.000Z")
  );

  const messages = withMailDropEnvAndCwd({ root, schoolDrop, personalDrop }, () => personalMessagesFromDrops(20));

  // Ordering is now Date.parse timestamp descending, fixing mixed string-date sorting.
  assert.deepEqual(messages, [
    {
      category: "personal",
      file: path.join(personalDrop, "newer-personal.eml"),
      subject: "Bank alert",
      from: "Bank <bank@example.com>",
      date: "Thu, 25 Jun 2026 08:00:00 +1000",
      modifiedAt: "2026-06-24T01:10:00.000Z",
      body: [
        "Subject: Bank alert",
        "From: Bank <bank@example.com>",
        "Date: Thu, 25 Jun 2026 08:00:00 +1000",
        "",
        "Account notice."
      ].join("\n"),
      key: "thu, 25 jun 2026 08:00:00 +1000|bank <bank@example.com>|bank alert"
    },
    {
      category: "personal",
      file: path.join(personalDrop, "gmail-snapshot-20260624.md"),
      id: "g-1",
      date: "2026-06-24T01:00:00Z",
      from: "Google Alerts",
      subject: "Security alert",
      labels: "INBOX",
      key: "gmail|g-1"
    },
    {
      category: "personal",
      file: path.join(personalDrop, "gmail-snapshot-20260624.md"),
      id: "g-3",
      date: "2026-06-23T23:00:00Z",
      from: "School Updates",
      subject: "Campus note",
      labels: "INBOX,IMPORTANT",
      key: "gmail|g-3"
    }
  ]);
});
