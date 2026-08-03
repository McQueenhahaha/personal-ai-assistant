import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStopRequested, killProcessTree } from "../src/codex-auto-worker.mjs";

// 用户按下 /stop 后眼看着任务继续跑完(codex 最长 1800 秒)，因为此前急停只在
// 每轮入口检查一次。这些测试守住"执行期间也能被中断"。

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-stop-"));
  fs.mkdirSync(path.join(root, "data", "state"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("isStopRequested only reports true once the stop flag exists", (t) => {
  const root = tempRoot(t);
  assert.equal(isStopRequested(root), false);
  fs.writeFileSync(path.join(root, "data", "state", "assistant-stop.flag"), "2026-08-03T09:00:00Z\n");
  assert.equal(isStopRequested(root), true);
});

test("isStopRequested reads the given root, not the developer machine state", (t) => {
  // 本仓踩过这个坑：开发机上一个残留标志让 9 个无关测试失败。
  const root = tempRoot(t);
  assert.equal(isStopRequested(root, () => false), false);
});

test("killProcessTree asks taskkill for the whole tree, never a bare child kill", () => {
  const calls = [];
  const ok = killProcessTree(4321, (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  });

  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "taskkill.exe");
  // /T 是关键：审计确认过 child.kill() 只终止直接子进程，
  // codex 派生的孙进程(DISM/SFC 之类)会继续跑。
  assert.deepEqual(calls[0].args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[0].options.shell, false);
});

test("killProcessTree refuses obviously invalid pids", () => {
  let spawned = 0;
  const spy = () => { spawned += 1; return { status: 0 }; };
  for (const pid of [0, -1, 1.5, NaN, undefined, null]) {
    assert.equal(killProcessTree(pid, spy), false, String(pid));
  }
  assert.equal(spawned, 0, "非法 pid 绝不能真的去 taskkill");
});

test("the bridge never kills processes itself", () => {
  // 回归守卫：桥无法安全区分"正在执行的任务"与自己/supervisor/看门狗，
  // 按命令行特征杀进程早晚误杀。终止必须由拥有子进程的 worker 执行。
  const source = fs.readFileSync(new URL("../src/openclaw-telegram-bridge.mjs", import.meta.url), "utf8");
  const offenders = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .filter((line) => /taskkill|Stop-Process|killProcessTree|\.kill\(/.test(line));
  assert.deepEqual(offenders, [], "桥内不得出现任何杀进程调用");
});
