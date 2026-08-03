import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(".");
const OUTLOOK_SCRIPT = path.join(ROOT, "scripts", "export-outlook-mail.ps1");

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(source, timeout = 15000) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { encoding: "utf8", shell: false, windowsHide: true, timeout }
  );
}

test("Outlook export does not call Quit when Outlook was already open", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-outlook-com-"));
  const scripts = path.join(root, "scripts");
  const outDir = path.join(root, "output");
  fs.mkdirSync(scripts, { recursive: true });
  fs.copyFileSync(OUTLOOK_SCRIPT, path.join(scripts, "export-outlook-mail.ps1"));
  fs.writeFileSync(path.join(scripts, "openclaw-env.ps1"), "", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = `
$global:QuitCalls = 0
$global:Events = [System.Collections.Generic.List[string]]::new()
$global:FakeNamespace = [pscustomobject]@{ Stores = [pscustomobject]@{ Count = 0 } }
$global:FakeNamespace | Add-Member -MemberType ScriptMethod -Name Logon -Value { }
$global:FakeOutlook = [pscustomobject]@{}
$global:FakeOutlook | Add-Member -MemberType ScriptMethod -Name GetNamespace -Value { param($Name) return $global:FakeNamespace }
$global:FakeOutlook | Add-Member -MemberType ScriptMethod -Name Quit -Value { $global:QuitCalls += 1 }
function Get-Process {
  [CmdletBinding()] param([string]$Name)
  $global:Events.Add('process-check')
  [pscustomobject]@{ Id = 1234; ProcessName = 'OUTLOOK' }
}
function Get-ItemProperty {
  [CmdletBinding()] param([string]$Path, [string]$Name)
  [pscustomobject]@{ DefaultProfile = 'Outlook' }
}
function New-Object {
  [CmdletBinding(DefaultParameterSetName='Type')]
  param(
    [Parameter(Mandatory, Position=0, ParameterSetName='Type')][string]$TypeName,
    [Parameter(Mandatory, ParameterSetName='Com')][string]$ComObject
  )
  if ($PSCmdlet.ParameterSetName -eq 'Com') {
    $global:Events.Add('com-create')
    return $global:FakeOutlook
  }
  Microsoft.PowerShell.Utility\\New-Object -TypeName $TypeName
}
& ${psQuote(path.join(scripts, "export-outlook-mail.ps1"))} -NoSync -OutDir ${psQuote(outDir)} -AccountContains 'school.example'
[Console]::Out.WriteLine((@{ quitCalls = $global:QuitCalls; events = @($global:Events) } | ConvertTo-Json -Compress))
`;
  const result = runPowerShell(source);
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(state.quitCalls, 0);
  assert.deepEqual(state.events, ["process-check", "com-create"]);
});

test("Outlook COM cleanup is in finally and warns instead of killing duplicate processes", () => {
  const source = fs.readFileSync(OUTLOOK_SCRIPT, "utf8");
  assert.deepEqual([...fs.readFileSync(OUTLOOK_SCRIPT).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /\$StartedOutlook\s+-and\s+\$null\s+-ne\s+\$outlook/);
  assert.match(source, /\$outlook\.Quit\(\)/);
  assert.match(source, /ReleaseComObject\(\$namespace\)/);
  assert.match(source, /ReleaseComObject\(\$outlook\)/);
  assert.match(source, /\$OutlookProcessesBefore\.Count\s+-gt\s+1/);
  assert.doesNotMatch(source, /Stop-Process/);
});
