import { test } from "node:test";
import assert from "node:assert/strict";
import { outlookExportThrottled } from "../src/school/workflow.mjs";

test("outlook export throttle allows missing last export", () => {
  assert.equal(outlookExportThrottled(null, 1000, 30), false);
});

test("outlook export throttle blocks exports inside the minimum interval", () => {
  assert.equal(outlookExportThrottled(new Date(0).toISOString(), 10 * 60000, 30), true);
});

test("outlook export throttle allows exports after the minimum interval", () => {
  assert.equal(outlookExportThrottled(new Date(0).toISOString(), 40 * 60000, 30), false);
});
