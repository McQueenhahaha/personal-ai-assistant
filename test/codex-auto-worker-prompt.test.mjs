import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt } from "../src/codex-auto-worker.mjs";

test("buildPrompt uses answer-only prompt for Telegram chat tasks", () => {
  const prompt = buildPrompt({
    taskType: "telegram-chat",
    prompt: "你好",
    title: "t",
    priority: "normal",
    source: "s"
  });

  assert.equal(prompt.includes("只回答"), true);
  assert.equal(prompt.includes("不要修改"), true);
  assert.equal(prompt.includes("你好"), true);
});

test("buildPrompt keeps maintenance prompt for remote maintenance tasks", () => {
  const prompt = buildPrompt({
    taskType: "remote-maintenance",
    prompt: "x",
    title: "t",
    priority: "normal",
    source: "s"
  });

  assert.equal(prompt.includes("请自动完成任务"), true);
});

test("buildPrompt creates an engineering study document prompt", () => {
  const prompt = buildPrompt({
    taskType: "study-distill",
    prompt: "断裂力学",
    title: "t",
    priority: "high",
    source: "s"
  });

  assert.equal(prompt.includes("航空工程"), true);
  assert.equal(prompt.includes("自测题"), true);
  assert.equal(prompt.includes("断裂力学"), true);
});
