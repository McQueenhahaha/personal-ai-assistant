import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDirectMode } from "../src/openclaw-telegram-bridge.mjs";

function makeFiles(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-telegram-direct-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    stateFile: path.join(root, "bridge-state.json"),
    offsetFile: path.join(root, "offset.json"),
    heartbeatFile: path.join(root, "heartbeat.json")
  };
}

function quietLogger(errors = []) {
  return {
    log() {},
    warn() {},
    error(message) { errors.push(message); }
  };
}

test("runDirectMode continues polling after fetchUpdates throws", async (t) => {
  const files = makeFiles(t);
  const errors = [];
  let calls = 0;

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: false,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(errors),
    fetchUpdatesImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("simulated fetch failure");
      return [{
        update_id: 41,
        message: { message_id: 7, date: 1, chat: { id: 123 }, text: "old" }
      }];
    }
  });

  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Error: simulated fetch failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.offsetFile, "utf8")), { offset: 42 });
});

test("runDirectMode does not write an offset when the initial baseline fetch is empty", async (t) => {
  const files = makeFiles(t);

  await runDirectMode({
    token: "test-token",
    chatId: "123",
    ...files,
    dryRun: true,
    processExisting: false,
    once: true,
    retrySeconds: 0,
    failureWarnThreshold: 5,
    logger: quietLogger(),
    fetchUpdatesImpl: async ({ offset }) => {
      assert.equal(offset, -1);
      return [];
    }
  });

  assert.equal(fs.existsSync(files.offsetFile), false);
  const heartbeat = JSON.parse(fs.readFileSync(files.heartbeatFile, "utf8"));
  assert.equal(Number.isFinite(heartbeat.atMs), true);
  assert.equal(heartbeat.offset, -1);
  assert.equal(heartbeat.lastUpdates, 0);
});
