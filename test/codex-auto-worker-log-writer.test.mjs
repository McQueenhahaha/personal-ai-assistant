import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedactingLogWriter } from "../src/codex-auto-worker.mjs";

test("日志写不进去时不许掀翻 worker 进程", async (t) => {
  // 传一个目录当日志文件：createWriteStream 会异步 emit EISDIR/EPERM。
  // 没有 error 监听器的话，那是个 unhandled 'error' —— 直接打死进程，
  // 连跑测试的这个 node 都会被打死（所以修复前这条是"进程消失"式的红）。
  //
  // 真实后果比"少了几行日志"重得多：worker 死了，你收到「任务被中断」，
  // codex 改到一半的文件留在仓库里，而它那个 danger-full-access 子进程
  // 没人 kill，成了孤儿继续跑。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-logwriter-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writer = createRedactingLogWriter(dir);
  assert.doesNotThrow(() => {
    writer.write("第一行\n");
    writer.write("第二行\n");
    writer.end();
  });

  // 给 stream 一个 tick 把 error 抛出来；有监听器就只是被记下，进程活着。
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(true, "走到这里就说明进程没被 unhandled error 干掉");
});

test("正常路径仍然写文件，并且写进去的是脱敏后的内容", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-logwriter-ok-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "task.log");

  const writer = createRedactingLogWriter(file);
  writer.write("token 是 8012345678:AAH1abcdefghijklmnopqrstuvwxyz012345\n");
  writer.end();

  return new Promise((resolve) => {
    setTimeout(() => {
      const text = fs.readFileSync(file, "utf8");
      assert.equal(text.includes("8012345678:AAH1"), false, "日志里不该留明文 token");
      assert.match(text, /TELEGRAM_BOT_TOKEN|REDACTED/);
      resolve();
    }, 60);
  });
});
