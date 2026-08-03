import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(".");
const REQUEST_SCRIPT = path.join(ROOT, "scripts", "interactive", "request-interactive-task.ps1");
const RUNNER_SCRIPT = path.join(ROOT, "scripts", "interactive", "run-interactive-task.ps1");
const REGISTER_SCRIPT = path.join(ROOT, "scripts", "register-interactive-task.ps1");
const UNREGISTER_SCRIPT = path.join(ROOT, "scripts", "unregister-interactive-task.ps1");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(source, { input = "", env = process.env, timeout = 15000 } = {}) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { encoding: "utf8", input, env, shell: false, windowsHide: true, timeout }
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function interactiveFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-interactive-task-"));
  const scripts = path.join(root, "scripts");
  const interactive = path.join(scripts, "interactive");
  fs.mkdirSync(interactive, { recursive: true });
  fs.copyFileSync(REQUEST_SCRIPT, path.join(interactive, "request-interactive-task.ps1"));
  fs.copyFileSync(RUNNER_SCRIPT, path.join(interactive, "run-interactive-task.ps1"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, scripts, interactive };
}

test("interactive request writes JSON, triggers the runner, and reads its result", (t) => {
  const fixture = interactiveFixture(t);
  const screenshot = path.join(fixture.root, "data", "screenshots", "screen.png");
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.scripts, "take-screenshot.ps1"),
    `[Console]::Out.WriteLine(${psQuote(screenshot)})\n`,
    "utf8"
  );
  const runner = path.join(fixture.interactive, "run-interactive-task.ps1");
  const request = path.join(fixture.interactive, "request-interactive-task.ps1");
  const requestCapture = path.join(fixture.root, "request-capture.json");
  const source = `
function Start-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  if ($TaskName -cne 'PAI Interactive Task') { throw 'wrong task name' }
  Get-ChildItem -LiteralPath ${psQuote(path.join(fixture.root, "data", "interactive", "requests"))} -Filter '*.json' | Select-Object -First 1 | Copy-Item -Destination ${psQuote(requestCapture)}
  & ${psQuote(runner)}
}
& ${psQuote(request)} -Action screen -TimeoutSeconds 3
`;
  const result = runPowerShell(source, { input: JSON.stringify({ prompt: "查看屏幕" }) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), screenshot);
  assert.deepEqual(readJson(requestCapture), {
    id: readJson(requestCapture).id,
    action: "screen",
    prompt: "查看屏幕",
    timeoutSeconds: 3,
    requestedAt: readJson(requestCapture).requestedAt
  });
  const requests = fs.readdirSync(path.join(fixture.root, "data", "interactive", "requests"));
  assert.deepEqual(requests, []);
  const resultFiles = fs.readdirSync(path.join(fixture.root, "data", "interactive", "results"));
  assert.equal(resultFiles.length, 1);
  const stored = readJson(path.join(fixture.root, "data", "interactive", "results", resultFiles[0]));
  assert.equal(stored.action, "screen");
  assert.equal(stored.status, "ok");
});

test("interactive request times out according to timeoutSeconds", (t) => {
  const fixture = interactiveFixture(t);
  const request = path.join(fixture.interactive, "request-interactive-task.ps1");
  const source = `
function Start-ScheduledTask { [CmdletBinding()] param([string]$TaskName) }
& ${psQuote(request)} -Action screen -TimeoutSeconds 1
`;
  const startedAt = Date.now();
  const result = runPowerShell(source, { input: JSON.stringify({ prompt: "查看屏幕" }) });
  const elapsed = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timeout=1s/);
  assert.ok(elapsed >= 800, `returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 5000, `ignored payload timeout and took ${elapsed}ms`);
});

test("unlisted interactive actions are rejected before Task Scheduler is triggered", (t) => {
  const fixture = interactiveFixture(t);
  const marker = path.join(fixture.root, "task-started.txt");
  const request = path.join(fixture.interactive, "request-interactive-task.ps1");
  const source = `
function Start-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  Set-Content -LiteralPath ${psQuote(marker)} -Value 'started'
}
& ${psQuote(request)} -Action maintenance -TimeoutSeconds 1
`;
  const result = runPowerShell(source, { input: JSON.stringify({ prompt: "volume-status" }) });

  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(path.join(fixture.root, "data")), false);
});

test("hostile Outlook prompt stays data and only bounded numeric options reach the fixed exporter", (t) => {
  const fixture = interactiveFixture(t);
  const argsFile = path.join(fixture.root, "outlook-args.json");
  fs.writeFileSync(
    path.join(fixture.scripts, "export-outlook-mail.ps1"),
    `param([int]$Days, [int]$MaxMessages)\n@{ days = $Days; maxMessages = $MaxMessages } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${psQuote(argsFile)} -Encoding UTF8\nWrite-Output 'export-ok'\n`,
    "utf8"
  );
  const malicious = "过去 7 天，最多 12 封; whoami && type C:\\secret.txt\n`Get-ChildItem`";
  const requests = path.join(fixture.root, "data", "interactive", "requests");
  fs.mkdirSync(requests, { recursive: true });
  fs.writeFileSync(path.join(requests, "hostile.json"), `\uFEFF${JSON.stringify({
    id: "hostile",
    action: "outlook",
    prompt: malicious,
    timeoutSeconds: 10
  })}`, "utf8");

  const result = runPowerShell(`& ${psQuote(path.join(fixture.interactive, "run-interactive-task.ps1"))}`);
  assert.equal(result.status, 0, result.stderr);
  const args = readJson(argsFile);
  assert.deepEqual(args, { maxMessages: 12, days: 7 });
  const stored = readJson(path.join(fixture.root, "data", "interactive", "results", "hostile.json"));
  assert.equal(stored.status, "ok");
  assert.equal(stored.output, "export-ok");
  assert.equal(stored.output.includes("whoami"), false);
  assert.equal(stored.output.includes("secret.txt"), false);
  assert.equal(stored.output.includes("Get-ChildItem"), false);
});

test("runner rejects an unlisted action without invoking either fixed action script", (t) => {
  const fixture = interactiveFixture(t);
  const marker = path.join(fixture.root, "invoked.txt");
  for (const name of ["take-screenshot.ps1", "export-outlook-mail.ps1"]) {
    fs.writeFileSync(path.join(fixture.scripts, name), `Set-Content -LiteralPath ${psQuote(marker)} -Value 'invoked'\n`, "utf8");
  }
  const requests = path.join(fixture.root, "data", "interactive", "requests");
  fs.mkdirSync(requests, { recursive: true });
  fs.writeFileSync(path.join(requests, "denied.json"), JSON.stringify({
    id: "denied",
    action: "Screen",
    prompt: "; whoami",
    timeoutSeconds: 10
  }), "utf8");

  const result = runPowerShell(`& ${psQuote(path.join(fixture.interactive, "run-interactive-task.ps1"))}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
  const stored = readJson(path.join(fixture.root, "data", "interactive", "results", "denied.json"));
  assert.equal(stored.status, "rejected");
  assert.equal(stored.reason, "action not in whitelist");
});

test("interactive task scripts have the required task shape, syntax, and UTF-8 BOM", () => {
  const ps1Files = [REQUEST_SCRIPT, RUNNER_SCRIPT, REGISTER_SCRIPT, UNREGISTER_SCRIPT];
  for (const file of ps1Files) {
    assert.deepEqual([...fs.readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf], file);
  }

  const registration = fs.readFileSync(REGISTER_SCRIPT, "utf8");
  assert.match(registration, /run-hidden\.vbs/);
  assert.match(registration, /-LogonType Interactive/);
  assert.match(registration, /-RunLevel Limited/);
  assert.doesNotMatch(registration, /New-ScheduledTaskTrigger/);

  const quotedFiles = ps1Files.map(psQuote).join(",");
  const parse = runPowerShell(`
$failed = $false
foreach ($file in @(${quotedFiles})) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
  if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error "\${file}: $($_.Message)" }; $failed = $true }
}
if ($failed) { exit 1 }
`);
  assert.equal(parse.status, 0, parse.stderr);
});
