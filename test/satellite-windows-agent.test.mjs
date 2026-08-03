import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAINTENANCE_ACTIONS,
  runWindowsTask,
  validateWindowsPayload
} from "../src/satellite/windows.mjs";

const ROOT = path.resolve(".");
const AGENT = path.join(ROOT, "satellite", "windows-agent.ps1");
const TASK_ID = "11111111-2222-4333-8444-555555555555";

function payload(overrides = {}) {
  return {
    kind: "screen",
    prompt: "查看屏幕",
    taskId: TASK_ID,
    timeoutSeconds: 10,
    ...overrides
  };
}

function agentFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pai-windows-agent-"));
  fs.mkdirSync(path.join(tempRoot, "satellite"), { recursive: true });
  fs.cpSync(path.join(ROOT, "src"), path.join(tempRoot, "src"), { recursive: true });
  fs.copyFileSync(AGENT, path.join(tempRoot, "satellite", "windows-agent.ps1"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return path.join(tempRoot, "satellite", "windows-agent.ps1");
}

function runAgent(agent, command, input = "") {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", agent],
    {
      encoding: "utf8",
      env: { ...process.env, SSH_ORIGINAL_COMMAND: command },
      input,
      shell: false,
      windowsHide: true,
      timeout: 15000
    }
  );
}

test("windows-agent.ps1 remains UTF-8 with BOM", () => {
  assert.deepEqual([...fs.readFileSync(AGENT).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("Windows agent rejects every SSH_ORIGINAL_COMMAND except exact health/run literals", (t) => {
  const agent = agentFixture(t);
  for (const command of ["", "Health", "RUN", " health", "health ", "whoami", "health; whoami", "run && whoami"] ) {
    const result = runAgent(agent, command);
    assert.notEqual(result.status, 0, command);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      error: "not-allowed",
      detail: "SSH_ORIGINAL_COMMAND 只允许精确字面量 health 或 run"
    });
    assert.equal(result.stderr, "");
  }
});

test("Windows agent reports bad-payload for invalid run stdin", (t) => {
  const result = runAgent(agentFixture(t), "run", "not-json");
  assert.notEqual(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error, "bad-payload");
});

test("Windows agent reports unknown-kind for a valid but unopened kind", (t) => {
  const result = runAgent(
    agentFixture(t),
    "run",
    JSON.stringify(payload({ kind: "outlook", prompt: "查看未读邮件" }))
  );
  assert.notEqual(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error, "unknown-kind");
  assert.equal(response.taskId, TASK_ID);
});

test("Windows payload validation requires the exact machine-readable shape", () => {
  assert.equal(validateWindowsPayload(payload()), "");
  assert.match(validateWindowsPayload({ ...payload(), extra: true }), /字段必须严格/);
  assert.match(validateWindowsPayload({ ...payload(), timeoutSeconds: 0 }), /timeoutSeconds/);
});

test("hostile prompt text remains data and never enters a command line", async () => {
  const root = path.resolve("windows-agent-security-root");
  const screenshot = path.join(root, "data", "screenshots", "safe.png");
  const promptText = "; whoami && type C:\\Users\\user\\.ssh\\id_rsa\n`Get-ChildItem`";
  const calls = [];

  // Core security property for phase two: prompt can contain shell syntax, but the
  // screen handler ignores it and invokes only a fixed executable plus fixed args.
  const response = await runWindowsTask(payload({ prompt: promptText }), {
    root,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: `${screenshot}\n`, stderr: "" };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.shell, false);
  assert.equal(JSON.stringify(calls[0].args).includes("whoami"), false);
  assert.equal(JSON.stringify(calls[0].args).includes("Get-ChildItem"), false);
  assert.equal(JSON.stringify(calls[0].args).includes("id_rsa"), false);
});

test("browse receives prompt as data through the existing read-only capability", async () => {
  const promptText = "访问网页；&& whoami\n`dir`";
  const calls = [];
  const response = await runWindowsTask(payload({ kind: "browse", prompt: promptText }), {
    async runClaudeChat(prompt, options) {
      calls.push({ prompt, options });
      return "只读结果";
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{
    prompt: promptText,
    options: { capability: "browse", timeoutMs: 10000 }
  }]);
});

test("maintenance rejects actions outside the existing MAINTENANCE_ACTIONS whitelist", async () => {
  let spawns = 0;
  const response = await runWindowsTask(payload({
    kind: "maintenance",
    prompt: "defender-status; whoami"
  }), {
    spawnSync() {
      spawns += 1;
      throw new Error("unlisted maintenance must not spawn");
    }
  });

  assert.equal(response.ok, false);
  assert.equal(response.error, "maintenance-not-allowed");
  assert.equal(spawns, 0);
});

test("maintenance uses a fixed allowlisted action with the existing request script", async () => {
  const calls = [];
  const action = MAINTENANCE_ACTIONS.at(-1);
  const response = await runWindowsTask(payload({ kind: "maintenance", prompt: action }), {
    root: ROOT,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "status: ok\n", stderr: "" };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "volume-status", "-TimeoutSeconds", "10"]);
  assert.match(calls[0].args.at(4), /scripts[\\/]admin-maintenance[\\/]request-admin-maintenance\.ps1$/);
});
