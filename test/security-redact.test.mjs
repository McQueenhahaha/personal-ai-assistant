import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSensitive } from "../src/security/redact.mjs";

test("redactSensitive masks standalone Canvas access tokens", () => {
  const token = "12345~" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
  const redacted = redactSensitive(`Canvas token: ${token}`);

  assert.equal(redacted, "Canvas token: [CANVAS_API_TOKEN]");
  assert.equal(redacted.includes(token), false);
});
