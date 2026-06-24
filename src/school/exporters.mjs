import path from "node:path";
import { spawnSync } from "node:child_process";

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

export function runGmailExport({ maxMessages, query, account }, { spawn = spawnSync } = {}) {
  const script = path.resolve("scripts", "export-gmail-mail.ps1");
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-MaxMessages",
    String(maxMessages)
  ];

  if (query) args.push("-Query", query);
  if (account) args.push("-Account", account);

  const result = spawn("powershell.exe", args, {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Gmail export failed").trim());
  }

  return (result.stdout || "").trim();
}
