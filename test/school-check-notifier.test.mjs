import assert from "node:assert/strict";
import test from "node:test";

import { sendOrPrint } from "../src/school/notifier.mjs";

test("sendOrPrint logs text without sending in dry run mode", async () => {
  const calls = [];
  let sendCalled = false;

  await sendOrPrint("hello", true, {
    send: async () => {
      sendCalled = true;
    },
    log: (text) => {
      calls.push(text);
    }
  });

  assert.deepEqual(calls, ["hello"]);
  assert.equal(sendCalled, false);
});

test("sendOrPrint awaits send without logging outside dry run mode", async () => {
  const calls = [];
  let logCalled = false;
  let sendFinished = false;

  const promise = sendOrPrint("hello", false, {
    send: async (text) => {
      calls.push(text);
      await Promise.resolve();
      sendFinished = true;
    },
    log: () => {
      logCalled = true;
    }
  });

  assert.equal(sendFinished, false);
  await promise;

  assert.deepEqual(calls, ["hello"]);
  assert.equal(logCalled, false);
  assert.equal(sendFinished, true);
});
