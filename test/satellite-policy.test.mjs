import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  needsBrowser,
  needsCanvas,
  needsGuiControl,
  needsScreen,
  pickCapability,
  TIER
} from "../src/security/policy.mjs";

test("needsGuiControl recognizes Chinese and English GUI actions", () => {
  assert.equal(needsGuiControl("帮我在 Photoshop 里裁个图"), true);
  assert.equal(needsGuiControl("在记事本里输入 hello"), true);
  assert.equal(needsGuiControl("把文件拖拽到上传框"), true);
  assert.equal(needsGuiControl("帮我在报税应用里填写这个表单"), true);
  assert.equal(needsGuiControl("Click the Save button"), true);
  assert.equal(needsGuiControl("Fill in the form in the desktop app"), true);
});

test("needsGuiControl rejects view-only and non-GUI tasks", () => {
  assert.equal(needsGuiControl("帮我截个图看看"), false);
  assert.equal(needsGuiControl("看看当前屏幕"), false);
  assert.equal(needsGuiControl("帮我浏览 Canvas"), false);
  assert.equal(needsGuiControl("Check my Outlook inbox"), false);
  assert.equal(needsGuiControl("Explain machine learning"), false);
  assert.equal(needsScreen("帮我截个图看看"), true);
});

test("GUI control requires T2 while screen viewing stays unprivileged", () => {
  assert.equal(classifyTask("帮我在 Photoshop 里裁个图").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("点击提交按钮").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("帮我截个图看看").tier, TIER.SANDBOX);
});

test("GUI routing sits after T3/T2 and before canvas/browser/screen", () => {
  const text = "点击 Canvas 网页里的按钮并截个图";
  const route = (tier) => pickCapability({
    tier,
    guiControl: needsGuiControl(text),
    needsCanvas: needsCanvas(text),
    needsBrowser: needsBrowser(text),
    needsScreen: needsScreen(text)
  });

  assert.equal(needsGuiControl(text), true);
  assert.equal(needsCanvas(text), true);
  assert.equal(needsBrowser(text), true);
  assert.equal(needsScreen(text), true);
  assert.equal(route(TIER.FORBIDDEN), "deny");
  assert.equal(route(TIER.PRIVILEGED), "confirm");
  assert.equal(route(TIER.SANDBOX), "gui-control");
});
