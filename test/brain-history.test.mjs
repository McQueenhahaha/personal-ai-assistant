import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendTurn,
  isStale,
  loadHistory,
  renderContext
} from "../src/brain/history.mjs";

const emptyHistory = () => ({ turns: [], updatedAt: null });
const turn = (role, text, atMs) => ({ role, text, atMs });

test("appendTurn appends a turn and updates the timestamp", () => {
  const history = emptyHistory();
  const next = appendTurn(history, turn("user", "hello", 1000));

  assert.deepEqual(next, {
    turns: [turn("user", "hello", 1000)],
    updatedAt: 1000
  });
});

test("appendTurn drops the oldest turns over maxTurns", () => {
  const history = {
    turns: [turn("user", "one", 1), turn("assistant", "two", 2)],
    updatedAt: 2
  };
  const next = appendTurn(history, turn("user", "three", 3), {
    maxTurns: 2,
    maxChars: 100
  });

  assert.deepEqual(next.turns, [
    turn("assistant", "two", 2),
    turn("user", "three", 3)
  ]);
});

test("appendTurn drops the oldest turns over maxChars", () => {
  const history = {
    turns: [turn("user", "123", 1), turn("assistant", "4567", 2)],
    updatedAt: 2
  };
  const next = appendTurn(history, turn("user", "89", 3), {
    maxTurns: 10,
    maxChars: 6
  });

  assert.deepEqual(next.turns, [
    turn("assistant", "4567", 2),
    turn("user", "89", 3)
  ]);
});

test("appendTurn enforces maxTurns and maxChars together", () => {
  const history = {
    turns: [
      turn("user", "111", 1),
      turn("assistant", "22", 2),
      turn("user", "333", 3)
    ],
    updatedAt: 3
  };
  const next = appendTurn(history, turn("assistant", "44", 4), {
    maxTurns: 3,
    maxChars: 5
  });

  assert.deepEqual(next.turns, [
    turn("user", "333", 3),
    turn("assistant", "44", 4)
  ]);
});

test("appendTurn returns new state without changing the input", () => {
  const history = {
    turns: [turn("user", "original", 1)],
    updatedAt: 1
  };
  const snapshot = structuredClone(history);
  const next = appendTurn(history, turn("assistant", "reply", 2));

  assert.notEqual(next, history);
  assert.notEqual(next.turns, history.turns);
  assert.deepEqual(history, snapshot);
});

test("isStale uses a strict idle boundary and treats empty history as stale", () => {
  const history = {
    turns: [turn("assistant", "reply", 1000)],
    updatedAt: 1000
  };

  assert.equal(isStale(history, 2000, 1000), false);
  assert.equal(isStale(history, 1999, 1000), false);
  assert.equal(isStale(history, 2001, 1000), true);
  assert.equal(isStale(emptyHistory(), 2001, 1000), true);
});

test("renderContext returns an empty string for empty history", () => {
  assert.equal(renderContext(emptyHistory()), "");
});

test("renderContext formats multiple turns", () => {
  const history = {
    turns: [
      turn("user", "我喜欢蓝色。", 1),
      turn("assistant", "记住了。", 2),
      turn("user", "我喜欢什么颜色？", 3)
    ],
    updatedAt: 3
  };

  assert.equal(renderContext(history), [
    "[最近对话]",
    "用户：我喜欢蓝色。",
    "助手：记住了。",
    "用户：我喜欢什么颜色？"
  ].join("\n"));
});

test("loadHistory returns empty history for missing files and invalid JSON", async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-history-"));
  const missingFile = path.join(tempDir, "missing.json");
  const invalidFile = path.join(tempDir, "invalid.json");
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));

  assert.deepEqual(await loadHistory(missingFile), emptyHistory());
  await fs.writeFile(invalidFile, "{not valid JSON", "utf8");
  assert.deepEqual(await loadHistory(invalidFile), emptyHistory());
});
