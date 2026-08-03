import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadState, saveState, statePath } from "../src/school-check.mjs";

const defaultState = {
  slots: {},
  seenMessageKeys: [],
  seenPersonalKeys: [],
  seenGameKeys: [],
  remindedDeadlineKeys: [],
  schoolCatchup: null,
  gameCatchup: null,
  lastDigestKey: null,
  lastDigestSentAt: null
};

function withTempCwd(fn) {
  const originalCwd = process.cwd();
  const tempDir = mkdtempSync(path.join(tmpdir(), "school-check-state-test-"));
  try {
    process.chdir(tempDir);
    return fn(tempDir);
  } finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeStateJson(value) {
  mkdirSync(path.dirname(statePath()), { recursive: true });
  writeFileSync(statePath(), value, "utf8");
}

function uniqueTail(prefix, count, limit) {
  return ["dup", ...Array.from({ length: count }, (_, index) => `${prefix}-${index}`), "tail"].slice(-limit);
}

test("statePath resolves state file relative to the current working directory", () => {
  withTempCwd((tempDir) => {
    assert.equal(statePath(), path.resolve(tempDir, "data/state/school-check-state.json"));
  });
});

test("loadState returns default state when the state file is missing", () => {
  withTempCwd(() => {
    assert.deepEqual(loadState(), defaultState);
  });
});

test("loadState returns default state when the state file has invalid JSON", () => {
  withTempCwd(() => {
    writeStateJson("{not json");

    assert.deepEqual(loadState(), defaultState);
  });
});

test("loadState returns valid partial state without filling missing fields", () => {
  withTempCwd(() => {
    const partialState = {
      slots: {
        "2026-06-24 10:30": "2026-06-24T00:30:00.000Z"
      },
      seenMessageKeys: ["school|one"]
    };
    writeStateJson(JSON.stringify(partialState));

    assert.deepEqual(loadState(), partialState);
  });
});

test("saveState writes deduplicated tail-capped JSON to statePath", () => {
  withTempCwd(() => {
    const state = {
      slots: {
        "2026-06-24 10:30": "2026-06-24T00:30:00.000Z"
      },
      seenMessageKeys: ["dup", ...Array.from({ length: 2004 }, (_, index) => `message-${index}`), "dup", "tail"],
      seenPersonalKeys: ["dup", ...Array.from({ length: 2003 }, (_, index) => `personal-${index}`), "dup", "tail"],
      seenGameKeys: ["dup", ...Array.from({ length: 2002 }, (_, index) => `game-${index}`), "dup", "tail"],
      remindedDeadlineKeys: ["dup", ...Array.from({ length: 1003 }, (_, index) => `deadline-${index}`), "dup", "tail"],
      schoolCatchup: {
        slotKey: "2026-06-24 10:30",
        slotLabel: "10:30",
        startedAt: "2026-06-24T00:30:00.000Z",
        until: "2026-06-24T02:00:00.000Z"
      },
      gameCatchup: null
    };

    const expectedState = {
      slots: {
        "2026-06-24 10:30": "2026-06-24T00:30:00.000Z"
      },
      seenMessageKeys: uniqueTail("message", 2004, 2000),
      seenPersonalKeys: uniqueTail("personal", 2003, 2000),
      seenGameKeys: uniqueTail("game", 2002, 2000),
      remindedDeadlineKeys: uniqueTail("deadline", 1003, 1000),
      schoolCatchup: {
        slotKey: "2026-06-24 10:30",
        slotLabel: "10:30",
        startedAt: "2026-06-24T00:30:00.000Z",
        until: "2026-06-24T02:00:00.000Z"
      },
      gameCatchup: null
    };

    saveState(state);

    assert.deepEqual(state, expectedState);
    assert.deepEqual(JSON.parse(readFileSync(statePath(), "utf8")), expectedState);
    assert.equal(readFileSync(statePath(), "utf8"), JSON.stringify(expectedState, null, 2));
  });
});
