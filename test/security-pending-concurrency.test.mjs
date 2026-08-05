import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApproval, loadApprovals, saveApprovals, withApprovalsLock } from "../src/security/pending.mjs";

function isolatedStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-approvals-"));
  const file = path.join(dir, "pending-approvals.json");
  const original = process.env.PENDING_APPROVALS_FILE;
  process.env.PENDING_APPROVALS_FILE = file;
  t.after(() => {
    if (original === undefined) delete process.env.PENDING_APPROVALS_FILE;
    else process.env.PENDING_APPROVALS_FILE = original;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

test("写审批是原子的 —— 不留临时文件，写到一半被杀也不会留下半截 JSON", (t) => {
  // 裸 writeFileSync 写到一半被杀（看门狗的 Stop-Process -Force、断电）就留下
  // 半截 JSON，之后 loadApprovals 每次 JSON.parse 抛错：/ok /no /stop /resume
  // 一律「命令执行失败」，而且是**永久**这样，直到人工删文件。
  const file = isolatedStore(t);

  saveApprovals({ ABC1234: { id: "ABC1234", status: "pending" } });

  assert.equal(fs.existsSync(`${file}.tmp`), false, "临时文件必须已经 rename 掉");
  assert.deepEqual(Object.keys(loadApprovals()), ["ABC1234"]);
  // 落盘的内容必须是完整可解析的 JSON。
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
});

test("锁在临界区内持有、离开时释放", (t) => {
  const file = isolatedStore(t);
  const lockDir = `${file}.lock`;

  let seenInside = false;
  const result = withApprovalsLock(() => {
    seenInside = fs.existsSync(lockDir);
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(seenInside, true, "临界区内必须持有锁");
  assert.equal(fs.existsSync(lockDir), false, "离开时必须释放");
});

test("函数抛错也要释放锁 —— 否则一次异常就把审批永久锁死", (t) => {
  const file = isolatedStore(t);
  const lockDir = `${file}.lock`;

  assert.throws(() => withApprovalsLock(() => { throw new Error("boom"); }), /boom/);
  assert.equal(fs.existsSync(lockDir), false);
});

test("拿不到锁时降级执行，不把调用方卡住", (t) => {
  // 进程死在持锁时会留下锁目录。那时宁可退化成加锁之前的行为，
  // 也绝不让桥卡在这里 —— 自旋上限钉死 100ms。
  const file = isolatedStore(t);
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir);
  t.after(() => fs.rmSync(lockDir, { recursive: true, force: true }));

  const startedAt = Date.now();
  const result = withApprovalsLock(() => "ran anyway");
  const elapsed = Date.now() - startedAt;

  assert.equal(result, "ran anyway", "拿不到锁也必须执行，不能静默跳过");
  // 这是同步阻塞事件循环的时间，必须有上界。单跑约 90ms，但全量并行时机器有
  // 负载、会涨到 180ms 上下 —— 卡在 150ms 就成了 flaky 测试，那比没有更糟。
  // 取 500ms：单次自旋参数被调大一个量级（比如回到 20 次或把间隔加到 100ms）
  // 一定会越过它，而正常负载波动越不过。
  assert.ok(elapsed < 500, `自旋阻塞过久（实测 ${elapsed}ms）`);
  assert.equal(fs.existsSync(lockDir), true, "别人的锁不该被我们删掉");
});

test("createApproval 走完之后不留锁目录", (t) => {
  const file = isolatedStore(t);
  createApproval({ prompt: "看一下 D:/notes/a.md", tier: "T2", reason: "测试" });

  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(Object.keys(loadApprovals()).length, 1);
});
