import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAlertGmailFailure } from "../src/school/workflow.mjs";

test("gmail failure alert waits for the minimum streak", () => {
  assert.equal(shouldAlertGmailFailure(2, null, 0), false);
});

test("gmail failure alert allows the first alert at the minimum streak", () => {
  assert.equal(shouldAlertGmailFailure(3, null, 0), true);
});

test("gmail failure alert is blocked during cooldown", () => {
  assert.equal(shouldAlertGmailFailure(3, new Date(0).toISOString(), 1 * 3600000), false);
});

test("gmail failure alert is allowed after cooldown", () => {
  assert.equal(shouldAlertGmailFailure(3, new Date(0).toISOString(), 25 * 3600000), true);
});
