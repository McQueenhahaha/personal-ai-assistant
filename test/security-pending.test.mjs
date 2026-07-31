import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpired, makeApprovalId, pruneApprovals } from "../src/security/pending.mjs";

test("makeApprovalId returns a short uppercase alphanumeric ID", () => {
  const first = makeApprovalId(1_754_000_000_000, 0);
  const second = makeApprovalId(1_754_000_000_000, 1);

  assert.match(first, /^[A-Z0-9]{6,8}$/);
  assert.match(second, /^[A-Z0-9]{6,8}$/);
  assert.notEqual(first, second);
});

test("isExpired treats expiresAtMs as an inclusive boundary", () => {
  const entry = { expiresAtMs: 10_000 };

  assert.equal(isExpired(entry, 9_999), false);
  assert.equal(isExpired(entry, 10_000), true);
  assert.equal(isExpired(entry, 10_001), true);
});

test("pruneApprovals removes expired pending and processed entries older than 24 hours", () => {
  const nowMs = 2_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const store = {
    ACTIVE1: { id: "ACTIVE1", status: "pending", createdAtMs: nowMs - 1000, expiresAtMs: nowMs + 1 },
    EXPIRE1: { id: "EXPIRE1", status: "pending", createdAtMs: nowMs - 1000, expiresAtMs: nowMs },
    RECENT1: { id: "RECENT1", status: "approved", createdAtMs: nowMs - dayMs + 1, expiresAtMs: nowMs - 500 },
    OLDNO01: { id: "OLDNO01", status: "denied", createdAtMs: nowMs - dayMs, expiresAtMs: nowMs - dayMs + 1000 },
    OLDEXP1: { id: "OLDEXP1", status: "expired", createdAtMs: nowMs - dayMs - 1, expiresAtMs: nowMs - dayMs }
  };

  const pruned = pruneApprovals(store, nowMs);

  assert.deepEqual(Object.keys(pruned).sort(), ["ACTIVE1", "RECENT1"]);
  assert.notEqual(pruned, store);
  assert.equal(store.EXPIRE1.status, "pending");
});
