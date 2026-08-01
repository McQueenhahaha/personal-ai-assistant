import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenExpiryStatus } from "../src/canvas/token-guard.mjs";

const expiryMs = Date.parse("2026-10-29T00:00:00.000Z");

test("tokenExpiryStatus keeps more than 14 days at ok", () => {
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs - (15 * 86400000)), {
    daysLeft: 15,
    level: "ok"
  });
});

test("tokenExpiryStatus applies warn and urgent boundaries", () => {
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs - (14 * 86400000)), {
    daysLeft: 14,
    level: "warn"
  });
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs - (4 * 86400000)), {
    daysLeft: 4,
    level: "warn"
  });
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs - (3 * 86400000)), {
    daysLeft: 3,
    level: "urgent"
  });
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs - 1), {
    daysLeft: 1,
    level: "urgent"
  });
});

test("tokenExpiryStatus treats the expiry instant and later as expired", () => {
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs), {
    daysLeft: 0,
    level: "expired"
  });
  assert.deepEqual(tokenExpiryStatus("2026-10-29", expiryMs + 86400000), {
    daysLeft: -1,
    level: "expired"
  });
});

test("tokenExpiryStatus handles missing or invalid expiry without alerting", () => {
  assert.deepEqual(tokenExpiryStatus("not-a-date", expiryMs), {
    daysLeft: null,
    level: "ok"
  });
});
