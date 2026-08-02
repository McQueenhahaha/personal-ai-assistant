import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = path.join(ROOT, "scripts", "bridge-keepalive.psm1");
const RUNNER_PATH = path.join(ROOT, "scripts", "run-openclaw-telegram-bridge.ps1");

function readRestartStates() {
  const escapedModulePath = MODULE_PATH.replaceAll("'", "''");
  const command = [
    `Import-Module '${escapedModulePath}' -Force`,
    "$states = @(",
    "  Get-BridgeRestartState -CurrentBackoffSeconds 2 -RanSeconds 1 -ExitCode 1",
    "  Get-BridgeRestartState -CurrentBackoffSeconds 4 -RanSeconds 1 -ExitCode 1",
    "  Get-BridgeRestartState -CurrentBackoffSeconds 30 -RanSeconds 1 -ExitCode 1",
    "  Get-BridgeRestartState -CurrentBackoffSeconds 16 -RanSeconds 61 -ExitCode 1",
    "  Get-BridgeRestartState -CurrentBackoffSeconds 16 -RanSeconds 1 -ExitCode 0",
    ")",
    "$states | ConvertTo-Json -Compress"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test("bridge keepalive backoff starts at 2s, doubles, caps, and resets", {
  skip: process.platform !== "win32"
}, () => {
  assert.deepEqual(readRestartStates(), [
    { WaitSeconds: 2, NextBackoffSeconds: 4 },
    { WaitSeconds: 4, NextBackoffSeconds: 8 },
    { WaitSeconds: 30, NextBackoffSeconds: 30 },
    { WaitSeconds: 2, NextBackoffSeconds: 4 },
    { WaitSeconds: 2, NextBackoffSeconds: 16 }
  ]);
});

test("bridge runner wires args and UTF-8 restart-only logging into its loop", () => {
  const script = fs.readFileSync(RUNNER_PATH, "utf8");

  assert.match(script, /while \(\$true\)/);
  assert.match(script, /openclaw-telegram-bridge\.mjs @args/);
  assert.match(script, /Get-BridgeRestartState/);
  assert.match(script, /bridge-keepalive\.log/);
  assert.match(script, /UTF8Encoding/);
  assert.match(script, /AppendAllText/);
});
