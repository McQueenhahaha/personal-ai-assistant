import { test } from "node:test";
import assert from "node:assert/strict";

import { formatCombinedDigest } from "../src/school/summaries.mjs";
import {
  digestContentKey,
  shouldSendDigest,
  updateGameCatchup
} from "../src/school/workflow.mjs";

const schoolMessage = {
  key: "school|assignment",
  subject: "Assignment update",
  from: "School",
  date: "2026-08-03"
};
const personalMessage = {
  key: "personal|security",
  subject: "Security alert",
  from: "Google",
  date: "2026-08-03"
};
const gameItem = {
  game: "War Thunder",
  sourceType: "official-site",
  source: "War Thunder News",
  title: "Development Sound Mods - War Thunder",
  pubDate: "2026-08-03T01:00:00.000Z",
  link: "https://example.com/game"
};

test("shouldSendDigest blocks same content", () => {
  assert.deepEqual(shouldSendDigest({
    contentKey: "same",
    lastSentKey: "same",
    lastSentAtMs: 0,
    nowMs: 60000,
    minIntervalMs: 300000
  }), { send: false, reason: "same-content" });
});

test("shouldSendDigest blocks different content inside the minimum interval", () => {
  assert.deepEqual(shouldSendDigest({
    contentKey: "new",
    lastSentKey: "old",
    lastSentAtMs: 1000,
    nowMs: 2000,
    minIntervalMs: 300000
  }), { send: false, reason: "too-soon" });
});

test("shouldSendDigest allows the first digest", () => {
  assert.deepEqual(shouldSendDigest({
    contentKey: "first",
    lastSentKey: null,
    lastSentAtMs: null,
    nowMs: 0,
    minIntervalMs: 300000
  }), { send: true, reason: "first-send" });
});

test("shouldSendDigest allows changed content after the minimum interval", () => {
  assert.deepEqual(shouldSendDigest({
    contentKey: "new",
    lastSentKey: "old",
    lastSentAtMs: 0,
    nowMs: 300000,
    minIntervalMs: 300000
  }), { send: true, reason: "new-content" });
});

test("digest content key is independent of item order", () => {
  const secondSchoolMessage = { ...schoolMessage, key: "school|second", subject: "Second update" };
  const secondGameItem = { ...gameItem, title: "Event Special Rewards", link: "https://example.com/second" };
  const forward = digestContentKey({
    schoolMessages: [schoolMessage, secondSchoolMessage],
    personalMessages: [personalMessage],
    gameItems: [gameItem, secondGameItem]
  });
  const reordered = digestContentKey({
    schoolMessages: [secondSchoolMessage, schoolMessage],
    personalMessages: [personalMessage],
    gameItems: [secondGameItem, gameItem]
  });

  assert.equal(forward, reordered);
  assert.match(forward, /^[a-f0-9]{64}$/);
});

test("open catchup with unchanged content sends only once across 12 checks", () => {
  // Regression: this 120-minute catchup loop running every five minutes caused 57 pushes on 2026-08-03.
  const catchupUntilMs = 120 * 60000;
  const contentKey = digestContentKey({ gameItems: [gameItem] });
  let lastSentKey = null;
  let lastSentAtMs = null;
  let sent = 0;

  for (let run = 0; run < 12; run += 1) {
    const nowMs = run * 5 * 60000;
    assert.equal(nowMs < catchupUntilMs, true);
    const decision = shouldSendDigest({
      contentKey,
      lastSentKey,
      lastSentAtMs,
      nowMs,
      minIntervalMs: 5 * 60000
    });
    if (decision.send) {
      sent += 1;
      lastSentKey = contentKey;
      lastSentAtMs = nowMs;
    }
  }

  assert.equal(sent, 1);
});

test("game catchup opens only for an empty slot and clears when content arrives", () => {
  const slots = [{ key: "2026-08-03 20:00", label: "20:00" }];
  const opened = updateGameCatchup({
    activeCatchup: null,
    slots,
    newItemCount: 0,
    catchupMinutes: 120,
    nowMs: 0,
    force: false
  });

  assert.deepEqual(opened, {
    slotKey: "2026-08-03 20:00",
    slotLabel: "20:00",
    startedAt: "1970-01-01T00:00:00.000Z",
    until: "1970-01-01T02:00:00.000Z"
  });
  assert.equal(updateGameCatchup({
    activeCatchup: null,
    slots,
    newItemCount: 1,
    catchupMinutes: 120,
    nowMs: 0,
    force: false
  }), null);
  assert.equal(updateGameCatchup({
    activeCatchup: opened,
    slots: [],
    newItemCount: 0,
    catchupMinutes: 120,
    nowMs: 300000,
    force: false
  }), opened);
  assert.equal(updateGameCatchup({
    activeCatchup: opened,
    slots: [],
    newItemCount: 1,
    catchupMinutes: 120,
    nowMs: 300000,
    force: false
  }), null);
});

test("combined digest includes all non-empty sections in one message", () => {
  const messages = [formatCombinedDigest({
    schoolMessages: [schoolMessage],
    personalMessages: [personalMessage],
    gameItems: [gameItem]
  }, { slotLabel: "20:00", timeZone: "Australia/Sydney" })];

  assert.equal(messages.length, 1);
  assert.match(messages[0], /^📬 20:00 检查/);
  assert.match(messages[0], /【学校】/);
  assert.match(messages[0], /【个人】/);
  assert.match(messages[0], /【游戏】/);
});

test("combined digest includes only the populated section", () => {
  const text = formatCombinedDigest({ schoolMessages: [schoolMessage] }, {
    slotLabel: "10:30",
    timeZone: "Australia/Sydney"
  });

  assert.match(text, /【学校】/);
  assert.doesNotMatch(text, /【个人】/);
  assert.doesNotMatch(text, /【游戏】/);
});

test("combined digest returns no message when every section is empty", () => {
  assert.equal(formatCombinedDigest({}, {
    slotLabel: "14:00",
    timeZone: "Australia/Sydney"
  }), "");
});
