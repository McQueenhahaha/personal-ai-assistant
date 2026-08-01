import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, needsBrowser, needsGuiControl, needsScreen, pickCapability, TIER } from "../src/security/policy.mjs";

test("needsScreen recognizes Chinese screen intents", () => {
  assert.equal(needsScreen("帮我截图看看"), true);
  assert.equal(needsScreen("看下屏幕"), true);
  assert.equal(needsScreen("我的屏幕现在是什么"), true);
  assert.equal(needsScreen("电脑上现在显示什么"), true);
  assert.equal(needsScreen("这个窗口里有什么"), true);
  assert.equal(needsScreen("[screen] 说明当前画面"), true);
});

test("needsScreen recognizes English intents and rejects browser-only wording", () => {
  assert.equal(needsScreen("Take a screenshot and describe it"), true);
  assert.equal(needsScreen("What's on my screen?"), true);
  assert.equal(needsScreen("帮我看下 canvas 上的作业"), false);
  assert.equal(needsScreen("Browse this website"), false);
  assert.equal(needsScreen("解释 screen resolution 是什么"), false);
});

test("screen viewing is classified as T1 while input remains T2", () => {
  assert.equal(classifyTask("帮我看下我的屏幕").tier, TIER.SANDBOX);
  assert.equal(classifyTask("Take a screenshot").tier, TIER.SANDBOX);
  assert.equal(classifyTask("点击屏幕上的确认按钮").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("在记事本输入 hello").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("Type hello into Notepad").tier, TIER.PRIVILEGED);
});

test("pickCapability enforces T3, T2, GUI, browser, screen, assist priority", () => {
  assert.equal(pickCapability({ tier: TIER.FORBIDDEN, guiControl: true, needsBrowser: true, needsScreen: true }), "deny");
  assert.equal(pickCapability({ tier: TIER.PRIVILEGED, guiControl: true, needsBrowser: true, needsScreen: true }), "confirm");
  assert.equal(pickCapability({ tier: TIER.SANDBOX, guiControl: true, needsBrowser: true, needsScreen: true }), "gui-control");
  assert.equal(pickCapability({ tier: TIER.READONLY, needsBrowser: true, needsScreen: true }), "browse");
  assert.equal(pickCapability({ tier: TIER.READONLY, needsScreen: true }), "screen");
  assert.equal(pickCapability({ tier: TIER.SANDBOX }), "assist");
});

test("real intent combinations select screen, browse, and T2 confirmation", () => {
  const screenshotText = "帮我看下我的屏幕";
  assert.equal(pickCapability({
    tier: TIER.READONLY,
    needsBrowser: needsBrowser(screenshotText),
    needsScreen: needsScreen(screenshotText)
  }), "screen");

  const browserText = "帮我看下 Canvas 网页上的作业";
  assert.equal(pickCapability({
    tier: TIER.READONLY,
    needsBrowser: needsBrowser(browserText),
    needsScreen: needsScreen(browserText)
  }), "browse");

  const clickText = "点击确认按钮";
  assert.equal(pickCapability({
    tier: TIER.PRIVILEGED,
    guiControl: needsGuiControl(clickText),
    needsBrowser: needsBrowser(clickText),
    needsScreen: needsScreen(clickText)
  }), "confirm");
});
