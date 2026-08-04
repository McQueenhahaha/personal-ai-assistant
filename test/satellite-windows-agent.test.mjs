import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERACTIVE_ACTIONS,
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

// 下面两条要真的把 windows-agent.ps1 跑起来，而它是 PowerShell 脚本。
// CI 跑在 ubuntu-latest 上没有 powershell.exe：spawnSync 拿不到 stdout，
// JSON.parse(undefined) 直接抛 —— 那不是被测代码有问题，是这条测试在那里没有可执行性。
const windowsOnly = { skip: process.platform !== "win32" && "需要 Windows PowerShell" };

test("windows-agent.ps1 remains UTF-8 with BOM", () => {
  assert.deepEqual([...fs.readFileSync(AGENT).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("Windows agent rejects every SSH_ORIGINAL_COMMAND except exact health/run literals", windowsOnly, (t) => {
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

test("Windows agent reports bad-payload for invalid run stdin", windowsOnly, (t) => {
  const result = runAgent(agentFixture(t), "run", "not-json");
  assert.notEqual(result.status, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, false);
  assert.equal(response.error, "bad-payload");
});

test("outlook is an opened kind and always uses the interactive request script", async () => {
  const calls = [];
  const promptText = JSON.stringify({ days: 14, maxMessages: 25 });
  const response = await runWindowsTask(payload({ kind: "outlook", prompt: promptText }), {
    root: ROOT,
    env: {},
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "Exported 25 Outlook message(s)\n", stderr: "" };
    }
  });

  assert.equal(response.ok, true);
  assert.deepEqual(INTERACTIVE_ACTIONS, ["screen", "outlook"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(4), /scripts[\\/]interactive[\\/]request-interactive-task\.ps1$/);
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "outlook", "-TimeoutSeconds", "10"]);
  assert.equal(calls[0].options.input, JSON.stringify({ prompt: promptText }));
  assert.equal(calls[0].options.shell, false);
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
    env: {},
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

test("screen delegates in an SSH session and keeps hostile prompt text out of command arguments", async () => {
  const root = path.resolve("windows-agent-security-root");
  const screenshot = path.join(root, "data", "screenshots", "ssh-safe.png");
  const promptText = "; whoami && type C:\\secret.txt\n`Get-ChildItem`";
  const calls = [];
  const response = await runWindowsTask(payload({ prompt: promptText }), {
    root,
    env: { SSH_CONNECTION: "100.64.0.1 50000 100.64.0.2 22" },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: `${screenshot}\n`, stderr: "" };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(4), /scripts[\\/]interactive[\\/]request-interactive-task\.ps1$/);
  assert.deepEqual(calls[0].args.slice(-4), ["-Action", "screen", "-TimeoutSeconds", "10"]);
  assert.equal(calls[0].options.input, JSON.stringify({ prompt: promptText }));
  assert.equal(JSON.stringify(calls[0].args).includes("whoami"), false);
  assert.equal(JSON.stringify(calls[0].args).includes("secret.txt"), false);
  assert.equal(JSON.stringify(calls[0].args).includes("Get-ChildItem"), false);
});

test("screen keeps the original direct screenshot path outside SSH sessions", async () => {
  const root = path.resolve("windows-agent-local-root");
  const screenshot = path.join(root, "data", "screenshots", "local.png");
  const calls = [];
  const response = await runWindowsTask(payload(), {
    root,
    env: { SSH_CONNECTION: "", SSH_CLIENT: "" },
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: `${screenshot}\n`, stderr: "" };
    }
  });

  assert.equal(response.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(4), /scripts[\\/]take-screenshot\.ps1$/);
  assert.equal(calls[0].args.includes("-Action"), false);
  assert.equal(calls[0].options.input, undefined);
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
