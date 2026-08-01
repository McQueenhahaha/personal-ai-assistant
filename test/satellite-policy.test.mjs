import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  needsBrowser,
  needsCanvas,
  needsMac,
  needsScreen,
  pickCapability,
  TIER
} from "../src/security/policy.mjs";

test("needsMac recognizes Chinese and English Mac intents", () => {
  assert.equal(needsMac("在 Mac 上帮我整理下载目录"), true);
  assert.equal(needsMac("看看 MacBook 上的日历"), true);
  assert.equal(needsMac("用我的笔记本打开这个文件"), true);
  assert.equal(needsMac("检查苹果电脑上的 Safari"), true);
  assert.equal(needsMac("Please do this on my MacBook"), true);
  assert.equal(needsMac("[mac] describe the desktop"), true);
});

test("needsMac rejects tasks without a Mac target", () => {
  assert.equal(needsMac("帮我截个图"), false);
  assert.equal(needsMac("帮我浏览 Canvas"), false);
  assert.equal(needsMac("Explain machine learning"), false);
  assert.equal(needsMac("查看 Windows 桌面"), false);
});

test("Mac clicks require T2 while read-only inspection stays unprivileged", () => {
  assert.equal(classifyTask("在 Mac 上点击提交按钮").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("看看 Mac 上下载文件夹有什么").tier, TIER.READONLY);
});

test("obvious Mac GUI application control requires T2", () => {
  assert.equal(classifyTask("在 Mac 上操作 Photoshop 应用").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("帮我在 Mac 上用 Photoshop 软件做海报").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("打开 Photoshop 应用并操作").tier, TIER.PRIVILEGED);
});

test("Mac routing sits after T3/T2 and before canvas/browser/screen", () => {
  const text = "[mac] 查看 Canvas 网页并截个图";
  const route = (tier) => pickCapability({
    tier,
    needsMac: needsMac(text),
    needsCanvas: needsCanvas(text),
    needsBrowser: needsBrowser(text),
    needsScreen: needsScreen(text)
  });

  assert.equal(needsMac(text), true);
  assert.equal(needsCanvas(text), true);
  assert.equal(needsBrowser(text), true);
  assert.equal(needsScreen(text), true);
  assert.equal(route(TIER.FORBIDDEN), "deny");
  assert.equal(route(TIER.PRIVILEGED), "confirm");
  assert.equal(route(TIER.SANDBOX), "mac");
});
