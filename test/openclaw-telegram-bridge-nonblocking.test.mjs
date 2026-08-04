import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runPowerShell } from "../src/openclaw-telegram-bridge.mjs";

// 真的要把 PowerShell 跑起来，Linux 上没有 powershell.exe。
const windowsOnly = { skip: process.platform !== "win32" && "需要 Windows PowerShell" };

test("维护命令执行期间事件循环仍在转 —— 否则急停按不动", windowsOnly, async (t) => {
  // 这条测的是安全边界：原来 runPowerShell 走 spawnSync，一条 /sfc_scan 能把
  // 事件循环冻住 620 秒。那段时间机器人读不到任何消息，包括 /stop ——
  // 急停在最需要它的时候恰好失效。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-ps-nonblock-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "sleep.ps1");
  fs.writeFileSync(script, "Start-Sleep -Seconds 2\r\nWrite-Output 'done'\r\n");

  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 100);
  try {
    const output = await runPowerShell(script, [], 30000);
    assert.equal(output, "done");
  } finally {
    clearInterval(timer);
  }

  // 2 秒里 100ms 的定时器该跳十几次。被 spawnSync 冻住时一次都不跳。
  assert.ok(ticks > 5, `事件循环被阻塞了（只跳了 ${ticks} 次）`);
});

test("非零退出仍然抛错，并带出脚本输出", windowsOnly, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-ps-fail-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "fail.ps1");
  fs.writeFileSync(script, "Write-Output 'boom detail'\r\nexit 3\r\n");

  await assert.rejects(() => runPowerShell(script, [], 30000), /boom detail/);
});

test("超时会杀掉子进程并抛错", windowsOnly, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-ps-timeout-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, "hang.ps1");
  fs.writeFileSync(script, "Start-Sleep -Seconds 30\r\n");

  await assert.rejects(() => runPowerShell(script, [], 1500), /timed out/);
});
