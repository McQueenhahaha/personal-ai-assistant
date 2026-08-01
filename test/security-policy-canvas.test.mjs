import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  needsBrowser,
  needsCanvas,
  needsScreen,
  pickCapability,
  TIER
} from "../src/security/policy.mjs";

test("needsCanvas recognizes Canvas, course codes, and assignment language", () => {
  assert.equal(needsCanvas("帮我看下 canvas 上的作业"), true);
  assert.equal(needsCanvas("ENGR1001 最近有什么"), true);
  assert.equal(needsCanvas("system engineering 的 group assessment 要干嘛"), true);
  assert.equal(needsCanvas("assignment due 是哪天"), true);
  assert.equal(needsCanvas("下次 quiz 和考试什么时候"), true);
});

test("needsCanvas rejects unrelated screen and local questions", () => {
  assert.equal(needsCanvas("帮我截个图"), false);
  assert.equal(needsCanvas("看看本地项目文件"), false);
  assert.equal(needsCanvas("今天悉尼天气如何"), false);
});

test("Canvas routing sits after T3/T2 and before browser/screen", () => {
  const text = "帮我看下 Canvas 网页上的 ENGR1001 作业";
  const route = (tier) => pickCapability({
    tier,
    needsCanvas: needsCanvas(text),
    needsBrowser: needsBrowser(text),
    needsScreen: needsScreen(text)
  });

  assert.equal(needsCanvas(text), true);
  assert.equal(needsBrowser(text), true);
  assert.equal(route(TIER.FORBIDDEN), "deny");
  assert.equal(route(TIER.PRIVILEGED), "confirm");
  assert.equal(route(classifyTask(text).tier), "canvas");
});
