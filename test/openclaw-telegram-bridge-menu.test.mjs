import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OWNER_COMMAND_MENU, validateCommandMenu } from "../src/openclaw/command-menu.mjs";

test("owner Telegram command menu is valid", () => {
  assert.deepEqual(validateCommandMenu(OWNER_COMMAND_MENU), []);
});

test("owner Telegram command menu includes key commands", () => {
  const commands = new Set(OWNER_COMMAND_MENU.map(({ command }) => command));

  assert.equal(commands.has("status"), true);
  assert.equal(commands.has("digest"), true);
  assert.equal(commands.has("web"), true);
  assert.equal(commands.has("screen"), true);
  assert.equal(commands.has("stop"), true);
  assert.equal(commands.has("defender_status"), true);

  // /mac 曾被当作调试开关刻意排除在菜单外。2026-08-04 反转：走卫星架构后，
  // Mac 的独有价值（微信、Mac 上的应用、桌面操控）正是通过它调用的，
  // 藏起来等于用户根本不知道有这个能力。
  assert.equal(commands.has("mac"), true);
  // /cancel 与 /stop 的差别必须两个都在菜单里才显得出来。
  assert.equal(commands.has("cancel"), true);
  // 待确认提醒给的是 ID，菜单里没有这两项就只能照着手打，打错就作废。
  assert.equal(commands.has("ok"), true);
  assert.equal(commands.has("no"), true);
});

test("菜单里承诺的每条命令，桥里都必须真的有实现", () => {
  // 取代原来写死的 `menu.length === 20`：那条改什么都红，而红了也不说明
  // 到底哪里不对。真正要防的是"菜单承诺了一个不存在的命令" ——
  // 用户点了没反应，而且是静默的。
  const source = fs.readFileSync(
    new URL("../src/openclaw-telegram-bridge.mjs", import.meta.url),
    "utf8"
  );
  const missing = OWNER_COMMAND_MENU
    .map(({ command }) => command)
    .filter((command) => !source.includes(`"/${command}"`));

  assert.deepEqual(missing, [], "菜单里有命令在桥里找不到处理分支");
});

test("owner Telegram command menu has no duplicate commands", () => {
  const commands = OWNER_COMMAND_MENU.map(({ command }) => command);

  assert.equal(new Set(commands).size, commands.length);
});

test("validateCommandMenu reports invalid command and description errors", () => {
  const errors = validateCommandMenu([
    { command: "Bad Command", description: "x".repeat(257) }
  ]);

  assert.equal(errors.length > 0, true);
});
