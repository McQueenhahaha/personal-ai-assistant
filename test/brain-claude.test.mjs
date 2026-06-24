import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrainPrompt } from "../src/brain/claude.mjs";

test("buildBrainPrompt includes the question text", () => {
  const prompt = buildBrainPrompt("今天有什么安排？");

  assert.match(prompt, /今天有什么安排？/);
});

test("buildBrainPrompt includes context when provided", () => {
  const prompt = buildBrainPrompt("帮我总结", "最近一条 Telegram 消息是作业提醒。");

  assert.match(prompt, /背景：/);
  assert.match(prompt, /最近一条 Telegram 消息是作业提醒。/);
});

test("buildBrainPrompt omits context section when context is empty", () => {
  const prompt = buildBrainPrompt("帮我总结");

  assert.doesNotMatch(prompt, /背景：/);
});

test("buildBrainPrompt returns a string for undefined question", () => {
  assert.equal(typeof buildBrainPrompt(undefined), "string");
});
