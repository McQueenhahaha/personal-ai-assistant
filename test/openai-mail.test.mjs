import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeMailMessages,
  parseGmailSnapshot,
  parseOutlookSnapshot,
  readMessageSource
} from "../src/openai.mjs";

function makeTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-openai-mail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("readMessageSource reads an existing file and otherwise returns body", (t) => {
  const root = makeTempRoot(t);
  const file = path.join(root, "message.md");
  fs.writeFileSync(file, "file body", "utf8");

  assert.equal(readMessageSource({ file, body: "ignored body" }), "file body");
  assert.equal(readMessageSource({ body: "inline body" }), "inline body");
  assert.equal(readMessageSource({}), "");
});

test("parseGmailSnapshot keeps current TSV parsing and skip rules", () => {
  const message = {
    category: "personal",
    file: "gmail-snapshot-20260624.md",
    subject: "Gmail snapshot",
    body: [
      "# Gmail Snapshot",
      "",
      "```text",
      "ID\tDate\tFrom\tSubject\tLabels\tThread",
      "g-1\t2026-06-24T01:00:00Z\tGoogle Alerts\tSecurity alert\tINBOX\tthread-a",
      "g-2\t2026-06-24T02:00:00Z\tDraft Sender\tDraft subject\tDRAFT,INBOX\tthread-b",
      "g-3\t2026-06-24T03:00:00Z\tTrash Sender\tTrash subject\tTRASH\tthread-c",
      "g-4\t2026-06-24T04:00:00Z\tSpam Sender\tSpam subject\tSPAM\tthread-d",
      "bad\tmissing",
      "g-5\t2026-06-23T23:00:00Z\tFriend\tDinner plans\tINBOX,IMPORTANT\tthread-e",
      "```"
    ].join("\n")
  };

  assert.deepEqual(parseGmailSnapshot(message), [
    {
      category: "personal",
      file: "gmail-snapshot-20260624.md",
      id: "g-1",
      date: "2026-06-24T01:00:00Z",
      from: "Google Alerts",
      subject: "Security alert",
      labels: "INBOX",
      thread: "thread-a",
      key: "gmail|g-1",
      body: "Security alert\nGoogle Alerts\nINBOX"
    },
    {
      category: "personal",
      file: "gmail-snapshot-20260624.md",
      id: "g-5",
      date: "2026-06-23T23:00:00Z",
      from: "Friend",
      subject: "Dinner plans",
      labels: "INBOX,IMPORTANT",
      thread: "thread-e",
      key: "gmail|g-5",
      body: "Dinner plans\nFriend\nINBOX,IMPORTANT"
    }
  ]);
});

test("parseOutlookSnapshot keeps current section parsing and empty-source behavior", () => {
  const message = {
    category: "school",
    file: "outlook-school-snapshot-20260624.md",
    date: "fallback-date",
    body: [
      "# Outlook Snapshot",
      "",
      "## Assignment 1 due",
      "- From: School Canvas <canvas@example.edu>",
      "- Received: Wed, 24 Jun 2026 10:00:00 +1000",
      "",
      "Submit your assignment.",
      "",
      "## Missing metadata notice",
      "Body without metadata.",
      "",
      "## ",
      "- From: Nobody",
      "- Received: missing subject date",
      "",
      "No subject."
    ].join("\n")
  };

  assert.deepEqual(parseOutlookSnapshot(message), [
    {
      category: "school",
      file: "outlook-school-snapshot-20260624.md",
      subject: "Assignment 1 due",
      from: "School Canvas <canvas@example.edu>",
      date: "Wed, 24 Jun 2026 10:00:00 +1000",
      key: "school|wed, 24 jun 2026 10:00:00 +1000|school canvas <canvas@example.edu>|assignment 1 due",
      body: "Submit your assignment."
    },
    {
      category: "school",
      file: "outlook-school-snapshot-20260624.md",
      subject: "Missing metadata notice",
      from: "unknown sender",
      date: "fallback-date",
      key: "school|fallback-date|unknown sender|missing metadata notice",
      body: ""
    }
  ]);
  assert.deepEqual(parseOutlookSnapshot({ category: "school", body: "no sections" }), []);
});

test("normalizeMailMessages expands snapshots, keeps ordinary mail, dedupes, filters, and sorts", () => {
  const gmailSnapshot = {
    category: "personal",
    file: "gmail-snapshot-20260624.md",
    subject: "Gmail snapshot",
    body: [
      "ID\tDate\tFrom\tSubject\tLabels\tThread",
      "g-1\t2026-06-24T01:00:00Z\tGoogle Alerts\tSecurity alert\tINBOX\tthread-a",
      "g-5\t2026-06-23T23:00:00Z\tFriend\tDinner plans\tINBOX,IMPORTANT\tthread-e"
    ].join("\n")
  };
  const outlookSnapshot = {
    category: "school",
    file: "outlook-school-snapshot-20260624.md",
    date: "fallback-date",
    body: [
      "## Assignment 1 due",
      "- From: School Canvas <canvas@example.edu>",
      "- Received: 2026-06-24T00:30:00Z",
      "",
      "Submit your assignment."
    ].join("\n")
  };
  const ordinary = {
    category: "personal",
    subject: "Plain mail",
    from: "Friend",
    date: "2026-06-25T00:00:00Z",
    body: "Hello"
  };
  const duplicate = {
    category: "personal",
    subject: "Duplicate security alert",
    from: "Other",
    date: "2026-06-26T00:00:00Z",
    key: "gmail|g-1"
  };
  const unreadable = {
    category: "personal",
    subject: "Could not read broken.eml",
    from: "Reader",
    date: "2026-06-27T00:00:00Z"
  };

  assert.deepEqual(normalizeMailMessages([gmailSnapshot, outlookSnapshot, ordinary, duplicate, unreadable]), [
    {
      category: "personal",
      subject: "Plain mail",
      from: "Friend",
      date: "2026-06-25T00:00:00Z",
      body: "Hello",
      key: "personal|2026-06-25t00:00:00z|friend|plain mail"
    },
    {
      category: "personal",
      file: "gmail-snapshot-20260624.md",
      id: "g-1",
      date: "2026-06-24T01:00:00Z",
      from: "Google Alerts",
      subject: "Security alert",
      labels: "INBOX",
      thread: "thread-a",
      key: "gmail|g-1",
      body: "Security alert\nGoogle Alerts\nINBOX"
    },
    {
      category: "school",
      file: "outlook-school-snapshot-20260624.md",
      subject: "Assignment 1 due",
      from: "School Canvas <canvas@example.edu>",
      date: "2026-06-24T00:30:00Z",
      key: "school|2026-06-24t00:30:00z|school canvas <canvas@example.edu>|assignment 1 due",
      body: "Submit your assignment."
    },
    {
      category: "personal",
      file: "gmail-snapshot-20260624.md",
      id: "g-5",
      date: "2026-06-23T23:00:00Z",
      from: "Friend",
      subject: "Dinner plans",
      labels: "INBOX,IMPORTANT",
      thread: "thread-e",
      key: "gmail|g-5",
      body: "Dinner plans\nFriend\nINBOX,IMPORTANT"
    }
  ]);
});

test("normalizeMailMessages falls back to original snapshot messages when parsing returns empty", () => {
  assert.deepEqual(
    normalizeMailMessages([
      {
        category: "personal",
        file: "gmail-snapshot-empty.md",
        subject: "Gmail snapshot",
        date: "2026-06-22T00:00:00Z",
        body: "ID\tDate\tFrom\tSubject\tLabels\tThread\nmissing\tfields"
      }
    ]),
    [
      {
        category: "personal",
        file: "gmail-snapshot-empty.md",
        subject: "Gmail snapshot",
        date: "2026-06-22T00:00:00Z",
        body: "ID\tDate\tFrom\tSubject\tLabels\tThread\nmissing\tfields"
      }
    ]
  );
  assert.deepEqual(
    normalizeMailMessages([
      {
        category: "school",
        file: "outlook-school-snapshot-empty.md",
        subject: "Outlook snapshot empty",
        from: "Exporter",
        date: "2026-06-21T00:00:00Z",
        body: "no sections"
      }
    ]),
    [
      {
        category: "school",
        file: "outlook-school-snapshot-empty.md",
        subject: "Outlook snapshot empty",
        from: "Exporter",
        date: "2026-06-21T00:00:00Z",
        body: "no sections"
      }
    ]
  );
});
