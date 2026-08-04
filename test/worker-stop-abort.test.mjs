import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { killProcessTree } from "../src/codex-auto-worker.mjs";
import { isPaused, isStopRequested, readPauseState, writePauseState } from "../src/state/pause.mjs";
import { SOUL_FILES } from "../src/brain/soul-sync.mjs";

// 用户按下 /stop 后眼看着任务继续跑完(codex 最长 1800 秒)，因为此前急停只在
// 每轮入口检查一次。这些测试守住"执行期间也能被中断"。

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pai-stop-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("pause levels drive the two different behaviours", (t) => {
  const root = tempRoot(t);

  assert.deepEqual(readPauseState(root), { level: "none", at: "" });
  assert.equal(isPaused(root), false);
  assert.equal(isStopRequested(root), false);

  writePauseState("pause", root);
  assert.equal(isPaused(root), true, "pause 要阻止领取新任务");
  assert.equal(isStopRequested(root), false, "pause 不该打断正在跑的任务");

  writePauseState("stop", root);
  assert.equal(isPaused(root), true);
  assert.equal(isStopRequested(root), true, "只有 stop 才中断正在跑的任务");

  writePauseState("none", root);
  assert.equal(isPaused(root), false, "/resume 必须同时解除 pause 与 stop");
  assert.equal(isStopRequested(root), false);
});

test("resume is expressed as content, never as a missing file", (t) => {
  // 灵魂包只搬运存在的文件、删除不传播。若用"删文件"表示恢复，
  // 大脑迁到另一台后对端仍留着旧标志 —— 助手会静默地又停下。
  const root = tempRoot(t);
  writePauseState("stop", root);
  writePauseState("none", root);
  const file = path.join(root, "data", "state", "assistant-pause-state.json");
  assert.equal(fs.existsSync(file), true, "恢复后文件必须仍然存在");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).level, "none");
});

test("pause state travels with the brain", () => {
  assert.ok(
    SOUL_FILES.includes("data/state/assistant-pause-state.json"),
    "急停不进灵魂包的话，大脑一迁移急停就静默失效"
  );
});

test("unreadable pause state degrades to running, not to a silent halt", (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, "data", "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "state", "assistant-pause-state.json"), "{broken");
  // 读不出状态就罢工是静默故障，用户无从察觉；继续运行至少是可观察的。
  assert.equal(isPaused(root), false);
});

test("pause state reads the given root, not the developer machine", (t) => {
  // 本仓踩过这个坑：开发机上一个残留标志让 9 个无关测试失败。
  const root = tempRoot(t);
  assert.equal(isPaused(root), false);
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
    // 唯一例外：runPowerShell 超时时终止**自己 spawn 出来的那个子进程**。
    // 它持有 handle，不需要按命令行特征去找谁该死 —— 这正是本守卫要求的
    // "由拥有子进程的一方终止"，不是它要防的那种误杀。
    // 而且这个行为一直存在：原先走 spawnSync 的 timeout 选项时同样会杀掉它，
    // 只是隐式发生、正则看不见。写成 spawn 之后才显形。
    .filter((line) => !/^\s*child\.kill\(\);?$/.test(line))
    .filter((line) => /taskkill|Stop-Process|killProcessTree|\.kill\(/.test(line));
  assert.deepEqual(offenders, [], "桥内不得出现按命令行特征杀进程的调用");
});
