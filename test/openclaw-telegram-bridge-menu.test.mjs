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
  assert.equal(commands.has("defender_status"), true);
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
