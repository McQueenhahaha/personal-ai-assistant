import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeterministicDigest,
  buildTodoItems,
  classifyPersonalMessage,
  classifySchoolMessage,
  compactLine,
  digestLooksReasonable,
  fieldValue,
  formatGameItem,
  formatPersonalItem,
  formatSchoolItem,
  gamePrefix,
  messageDateMs,
  outputText,
  rankedPersonalMessages,
  sectionBulletCount,
  translateGameTitle,
  translateSchoolTitle
} from "../src/openai.mjs";

const urgentMessage = {
  subject: "Security alert",
  from: "Google",
  date: "2026-06-24T00:00:00Z",
  labels: "INBOX"
};

const needsReplyMessage = {
  subject: "Please review and confirm repayment",
  from: "Afterpay",
  date: "2026-06-23T00:00:00Z",
  labels: "INBOX"
};

const noiseMessage = {
  subject: "50% discount",
  from: "Uber",
  date: "2026-06-25T00:00:00Z",
  labels: "PROMOTIONS"
};

const schoolSurveyMessage = {
  subject: "CES survey",
  from: "School",
  date: "2026-06-22",
  body: ""
};

const schoolAssignmentMessage = {
  subject: "Assignment Graded: Quiz",
  from: "Canvas",
  date: "2026-06-24",
  body: "Your marks are ready"
};

const gameNewsItem = {
  title: "Development Sound Mods - War Thunder",
  source: "War Thunder News",
  link: "https://example.test/news",
  game: "War Thunder",
  sourceType: "official-site"
};

test("response text, fields, dates, and compacting keep current behavior", () => {
  assert.equal(outputText({ output_text: " hello \n" }), "hello");
  assert.equal(outputText({ output: [{ content: [{ text: "a" }, { output_text: "b" }] }] }), "a\nb");
  assert.equal(fieldValue("- From: Alice\n- Subject: Test", "From"), "Alice");
  assert.equal(fieldValue("- Subject: Test", "From"), "");
  assert.equal(messageDateMs({ date: "2026-06-24T00:00:00Z" }), 1782259200000);
  assert.equal(messageDateMs({ modifiedAt: "2026-06-25T00:00:00Z" }), 1782345600000);
  assert.equal(messageDateMs({ date: "bad", modifiedAt: "also bad" }), 0);
  assert.equal(compactLine("  a\n\t b   c  "), "a b c");
});

test("school title translation and classification keep current labels", () => {
  assert.equal(translateSchoolTitle("Assignment Graded: Quiz"), "\u4f5c\u4e1a/\u6d4b\u9a8c\u5df2\u8bc4\u5206\uff1a\u6d4b\u9a8c");
  assert.equal(translateSchoolTitle("Reminder: Assignment is due tonight"), "\u63d0\u9192\uff1a\u4f5c\u4e1a \u4eca\u665a\u622a\u6b62");
  assert.equal(classifySchoolMessage(schoolSurveyMessage), "\u95ee\u5377/\u53cd\u9988");
  assert.equal(classifySchoolMessage({ subject: "Submission reminder", body: "deadline tonight" }), "\u4f5c\u4e1a/\u6d4b\u9a8c");
  assert.equal(classifySchoolMessage({ subject: "Canvas message for course", body: "message for you" }), "Canvas");
});

test("personal classifier returns full current classification objects", () => {
  assert.deepEqual(classifyPersonalMessage(urgentMessage), {
    kind: "Urgent",
    important: true,
    rank: 0,
    action: "\u6838\u5bf9\u8d26\u53f7\u5b89\u5168"
  });
  assert.deepEqual(classifyPersonalMessage(needsReplyMessage), {
    kind: "Needs reply",
    important: true,
    rank: 1,
    action: "\u9700\u8981\u5904\u7406/\u786e\u8ba4"
  });
  assert.deepEqual(classifyPersonalMessage({ subject: "New jobs and interview tips", from: "SEEK", labels: "INBOX" }), {
    kind: "FYI",
    important: true,
    rank: 2,
    action: "\u7559\u610f\u6c42\u804c/\u673a\u4f1a\u4fe1\u606f"
  });
  assert.deepEqual(classifyPersonalMessage({ subject: "Payment receipt", from: "Store", labels: "INBOX" }), {
    kind: "FYI",
    important: true,
    rank: 3,
    action: "\u7559\u6863\u6216\u67e5\u770b"
  });
  assert.deepEqual(classifyPersonalMessage(noiseMessage), {
    kind: "Noise",
    important: false,
    rank: 9,
    action: "\u4f4e\u4f18\u5148\u7ea7"
  });
  assert.deepEqual(classifyPersonalMessage({ subject: "Hello there", from: "Friend", labels: "INBOX" }), {
    kind: "FYI",
    important: true,
    rank: 4,
    action: "\u7559\u610f"
  });
});

test("mail formatting and ranking keep current full outputs", () => {
  assert.equal(
    formatSchoolItem(schoolAssignmentMessage),
    "- [\u6210\u7ee9/\u53cd\u9988] \u4f5c\u4e1a/\u6d4b\u9a8c\u5df2\u8bc4\u5206\uff1a\u6d4b\u9a8c\uff5cCanvas\uff5c2026-06-24"
  );
  assert.equal(
    formatPersonalItem(urgentMessage),
    "- [Urgent] \u6838\u5bf9\u8d26\u53f7\u5b89\u5168\uff1aSecurity alert\uff5cGoogle\uff5c2026-06-24T00:00:00Z"
  );
  assert.deepEqual(rankedPersonalMessages([noiseMessage, urgentMessage, needsReplyMessage]), [
    {
      message: urgentMessage,
      classification: {
        kind: "Urgent",
        important: true,
        rank: 0,
        action: "\u6838\u5bf9\u8d26\u53f7\u5b89\u5168"
      }
    },
    {
      message: needsReplyMessage,
      classification: {
        kind: "Needs reply",
        important: true,
        rank: 1,
        action: "\u9700\u8981\u5904\u7406/\u786e\u8ba4"
      }
    },
    {
      message: noiseMessage,
      classification: {
        kind: "Noise",
        important: false,
        rank: 9,
        action: "\u4f4e\u4f18\u5148\u7ea7"
      }
    }
  ]);
});

test("todo builder keeps current mixed and empty outputs", () => {
  assert.deepEqual(
    buildTodoItems({
      schoolMessages: [schoolSurveyMessage, schoolAssignmentMessage],
      personalMessages: [noiseMessage, urgentMessage, needsReplyMessage]
    }),
    [
      "- \u5148\u6838\u5bf9\u8d26\u53f7/\u767b\u5f55\u5b89\u5168\uff1aSecurity alert",
      "- \u5904\u7406\u4e2a\u4eba\u90ae\u4ef6\uff1aPlease review and confirm repayment",
      "- \u5982\u6709\u7a7a\uff0c\u5b8c\u6210\u5b66\u6821\u95ee\u5377/\u53cd\u9988\uff1aCES survey"
    ]
  );
  assert.deepEqual(buildTodoItems({ schoolMessages: [], personalMessages: [] }), [
    "- \u6682\u65e0\u660e\u786e\u5f85\u529e\u3002"
  ]);
});

test("game translation, prefixing, and formatting keep current full outputs", () => {
  assert.equal(translateGameTitle("Development Sound Mods - War Thunder"), "\u5f00\u53d1\u65e5\u5fd7\uff1a\u58f0\u97f3 Mod");
  assert.equal(gamePrefix({ sourceType: "official-site", game: "War Thunder" }), "\u6218\u96f7\u5b98\u65b9");
  assert.equal(gamePrefix({ sourceType: "tarkov-official", game: "Escape from Tarkov" }), "\u5854\u79d1\u592b\u5b98\u65b9");
  assert.equal(gamePrefix({ game: "Unknown Game" }), "Unknown Game");
  assert.equal(
    formatGameItem(gameNewsItem),
    "- [\u6218\u96f7\u5b98\u65b9] \u5f00\u53d1\u65e5\u5fd7\uff1a\u58f0\u97f3 Mod\uff5cWar Thunder News\n  https://example.test/news"
  );
});

test("deterministic digest keeps full empty and mixed output strings", () => {
  assert.equal(
    buildDeterministicDigest({ title: "Daily Digest", gameNews: [], schoolMessages: [], personalMessages: [] }),
    [
      "Daily Digest",
      "",
      "\u5b66\u6821",
      "- \u6682\u65e0\u5b66\u6821\u90ae\u4ef6\u6587\u4ef6\u3002\u628a\u5b66\u6821\u90ae\u4ef6\u5bfc\u51fa\u5230 `data/school-mail-drop` \u540e\uff0c\u6211\u4f1a\u5728\u8fd9\u91cc\u6574\u7406\u8bfe\u7a0b\u3001\u622a\u6b62\u65e5\u671f\u548c\u91cd\u8981\u901a\u77e5\u3002",
      "",
      "\u4e2a\u4eba\u90ae\u4ef6",
      "- \u6682\u65e0\u4e2a\u4eba\u90ae\u4ef6\u6587\u4ef6\u3002",
      "",
      "\u6e38\u620f\u8d44\u8baf",
      "- \u6682\u65e0\u6e38\u620f\u8d44\u8baf\u3002",
      "",
      "\u5f85\u529e",
      "- \u6682\u65e0\u660e\u786e\u5f85\u529e\u3002"
    ].join("\n")
  );

  assert.equal(
    buildDeterministicDigest({
      title: "Daily Digest",
      gameNews: [gameNewsItem],
      schoolMessages: [schoolSurveyMessage, schoolAssignmentMessage],
      personalMessages: [noiseMessage, urgentMessage, needsReplyMessage]
    }),
    [
      "Daily Digest",
      "",
      "\u5b66\u6821",
      "- [\u95ee\u5377/\u53cd\u9988] CES survey\uff5cSchool\uff5c2026-06-22",
      "- [\u6210\u7ee9/\u53cd\u9988] \u4f5c\u4e1a/\u6d4b\u9a8c\u5df2\u8bc4\u5206\uff1a\u6d4b\u9a8c\uff5cCanvas\uff5c2026-06-24",
      "",
      "\u4e2a\u4eba\u90ae\u4ef6",
      "- [Urgent] \u6838\u5bf9\u8d26\u53f7\u5b89\u5168\uff1aSecurity alert\uff5cGoogle\uff5c2026-06-24T00:00:00Z",
      "- [Needs reply] \u9700\u8981\u5904\u7406/\u786e\u8ba4\uff1aPlease review and confirm repayment\uff5cAfterpay\uff5c2026-06-23T00:00:00Z",
      "- \u5df2\u7565\u8fc7 1 \u5c01\u4fc3\u9500/\u6536\u636e\u7b49\u4f4e\u4f18\u5148\u7ea7\u90ae\u4ef6\u3002",
      "",
      "\u6e38\u620f\u8d44\u8baf",
      "- [\u6218\u96f7\u5b98\u65b9] \u5f00\u53d1\u65e5\u5fd7\uff1a\u58f0\u97f3 Mod\uff5cWar Thunder News",
      "  https://example.test/news",
      "",
      "\u5f85\u529e",
      "- \u5148\u6838\u5bf9\u8d26\u53f7/\u767b\u5f55\u5b89\u5168\uff1aSecurity alert",
      "- \u5904\u7406\u4e2a\u4eba\u90ae\u4ef6\uff1aPlease review and confirm repayment",
      "- \u5982\u6709\u7a7a\uff0c\u5b8c\u6210\u5b66\u6821\u95ee\u5377/\u53cd\u9988\uff1aCES survey"
    ].join("\n")
  );
});

test("digest validation keeps current section counting and rejection rules", () => {
  const digestText = [
    "Daily Digest",
    "",
    "\u5b66\u6821",
    "- one",
    "- two",
    "",
    "\u4e2a\u4eba\u90ae\u4ef6",
    "- one",
    "",
    "\u6e38\u620f\u8d44\u8baf",
    "- one",
    "",
    "\u5f85\u529e",
    "- one"
  ].join("\n");
  const tooManySchoolBullets = [
    "Daily Digest",
    "",
    "\u5b66\u6821",
    "- one",
    "- two",
    "- three",
    "- four",
    "- five",
    "",
    "\u4e2a\u4eba\u90ae\u4ef6",
    "- one",
    "",
    "\u6e38\u620f\u8d44\u8baf",
    "- one",
    "",
    "\u5f85\u529e",
    "- one"
  ].join("\n");

  assert.equal(sectionBulletCount(digestText, "\u5b66\u6821"), 2);
  assert.equal(digestLooksReasonable(digestText), true);
  assert.equal(digestLooksReasonable("\u5b66\u6821\n- one"), false);
  assert.equal(digestLooksReasonable(`${digestText}\ngmail-snapshot-2026`), false);
  assert.equal(digestLooksReasonable(tooManySchoolBullets), false);
});
