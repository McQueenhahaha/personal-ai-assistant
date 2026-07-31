import fs from "node:fs";
import path from "node:path";
import { resolveFromCwd } from "../env.mjs";
import { redactSensitive } from "./redact.mjs";

function auditFile() {
  return resolveFromCwd(process.env.AUDIT_LOG_FILE || "./data/logs/audit.jsonl");
}

export function appendAudit(entry = {}) {
  const record = {
    ts: entry.ts || new Date().toISOString(),
    kind: String(entry.kind || ""),
    tier: String(entry.tier || ""),
    reason: redactSensitive(entry.reason),
    promptPreview: redactSensitive(entry.promptPreview).slice(0, 160),
    result: String(entry.result || "")
  };
  if (entry.approvalId) record.approvalId = String(entry.approvalId);

  const file = auditFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  return record;
}
