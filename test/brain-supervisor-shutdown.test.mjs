import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureBrainServices } from "../src/brain/supervisor.mjs";

const source = fs.readFileSync(
  new URL("../src/brain/supervisor.mjs", import.meta.url),
  "utf8"
);

// 信号处理器只在「作为主模块运行」时注册，进程内测不到。
// 这是源码级守卫：钉住那个否则会静默消失的不变量。
// 2026-08-04 就是因为缺它排查了很久 —— launchctl unload 把 supervisor 杀掉，
// 它 spawn 的桥 unref 过、活了下来，继续霸占 Telegram 的 getUpdates，
// 另一台机器起桥就撞 409 并崩溃循环，两边都收不到消息。
test("supervisor 被终止时必须带走自己拉起的桥", () => {
  const entry = source.slice(source.indexOf("if (process.argv[1] &&"));
  assert.ok(entry, "找不到 CLI 入口块");

  for (const signal of ["SIGTERM", "SIGINT"]) {
    assert.ok(
      new RegExp(`["']${signal}["']`).test(entry),
      `入口必须处理 ${signal} —— launchctl unload 与关机都走它`
    );
  }
  assert.match(
    entry,
    /ensureBrainServices\(false\)/,
    "退出路径必须真的去停桥，只登记信号不算"
  );
});

test("停桥在「本来就没桥」时是安全的空操作", async (t) => {
  // 卫星节点收到 SIGTERM 时也会走这条路，不能因为没有 pid 文件就抛错。
  const root = fs.mkdtempSync(
    new URL("../data/tmp-", import.meta.url).pathname.replace(/^\//, "")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await ensureBrainServices(false, {
    platform: "darwin",
    repoRoot: root,
    kill: () => { throw new Error("不该杀任何东西"); }
  });
  assert.deepEqual(result, { running: false });
});
