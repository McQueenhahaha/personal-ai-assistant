import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runGmailExport, runOutlookExport } from "../src/school/exporters.mjs";

function fakeSpawn(result) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, spawn };
}

test("runOutlookExport spawns the current PowerShell command and returns trimmed stdout", () => {
  const { calls, spawn } = fakeSpawn({ status: 0, stdout: "  outlook exported  \n", stderr: "" });

  const output = runOutlookExport(
    { days: 9, maxMessages: 42, syncWaitSeconds: 13 },
    { spawn }
  );

  assert.equal(output, "outlook exported");
  assert.deepEqual(calls, [
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts", "export-outlook-mail.ps1"),
        "-Days",
        "9",
        "-MaxMessages",
        "42",
        "-SyncWaitSeconds",
        "13"
      ],
      options: {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    }
  ]);
});

test("runGmailExport spawns the current PowerShell command and returns trimmed stdout", () => {
  const { calls, spawn } = fakeSpawn({ status: 0, stdout: "  gmail exported  \n", stderr: "" });

  const output = runGmailExport(
    { maxMessages: 17, query: "from:test newer_than:2d", account: "demo@example.com" },
    { spawn }
  );

  assert.equal(output, "gmail exported");
  assert.deepEqual(calls, [
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts", "export-gmail-mail.ps1"),
        "-MaxMessages",
        "17",
        "-Query",
        "from:test newer_than:2d",
        "-Account",
        "demo@example.com"
      ],
      options: {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    }
  ]);
});

test("runOutlookExport preserves nonzero-status stderr failure behavior", () => {
  const { spawn } = fakeSpawn({
    status: 7,
    stdout: "stdout ignored",
    stderr: "  outlook stderr fail  \n"
  });

  assert.throws(
    () => runOutlookExport({ days: 1, maxMessages: 2, syncWaitSeconds: 3 }, { spawn }),
    { message: "outlook stderr fail" }
  );
});

test("runGmailExport preserves spawn error default failure behavior", () => {
  const { calls, spawn } = fakeSpawn({ error: new Error("spawn ENOENT") });

  assert.throws(
    () => runGmailExport({ maxMessages: 4, query: "", account: "" }, { spawn }),
    { message: "Gmail export failed" }
  );
  assert.deepEqual(calls, [
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts", "export-gmail-mail.ps1"),
        "-MaxMessages",
        "4"
      ],
      options: {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    }
  ]);
});
