import path from "node:path";
import { spawnSync } from "node:child_process";
import { exportGmailSnapshot } from "./gmail-export.mjs";

export function runOutlookExport({ days, maxMessages, syncWaitSeconds }, { spawn = spawnSync } = {}) {
  const script = path.resolve("scripts", "export-outlook-mail.ps1");
  const result = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Days",
      String(days),
      "-MaxMessages",
      String(maxMessages),
      "-SyncWaitSeconds",
      String(syncWaitSeconds)
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Outlook export failed").trim());
  }

  return (result.stdout || "").trim();
}

// Gmail 导出已从 PowerShell 搬到 Node（见 ./gmail-export.mjs）：大脑漂到 Mac 时
// 这件事仍然要做得了。Outlook 那个仍是 PowerShell —— 它走 COM，没法离开 Windows。
export function runGmailExport({ maxMessages, query, account }, dependencies = {}) {
  return exportGmailSnapshot({ maxMessages, query, account }, dependencies).message;
}
