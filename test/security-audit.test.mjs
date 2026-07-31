import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendAudit } from "../src/security/audit.mjs";

test("appendAudit writes parseable redacted JSONL", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-audit-"));
  const auditFile = path.join(tempDir, "logs", "audit.jsonl");
  const previous = process.env.AUDIT_LOG_FILE;
  process.env.AUDIT_LOG_FILE = auditFile;
  t.after(() => {
    if (previous === undefined) delete process.env.AUDIT_LOG_FILE;
    else process.env.AUDIT_LOG_FILE = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  appendAudit({
    ts: "2026-07-31T00:00:00.000Z",
    kind: "assist",
    tier: "T1",
    reason: "test",
    promptPreview: `TOKEN=super-secret-value ${"x".repeat(200)}`,
    result: "executed",
    approvalId: "A7K3QM"
  });

  const lines = fs.readFileSync(auditFile, "utf8").trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.promptPreview.includes("super-secret-value"), false);
  assert.equal(record.promptPreview.includes("TOKEN=[REDACTED]"), true);
  assert.equal(record.promptPreview.length <= 160, true);
  assert.equal(record.result, "executed");
  assert.equal(record.approvalId, "A7K3QM");
});
