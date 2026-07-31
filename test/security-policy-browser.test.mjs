import { test } from "node:test";
import assert from "node:assert/strict";
import { needsBrowser } from "../src/security/policy.mjs";

test("needsBrowser recognizes Chinese browser intents", () => {
  assert.equal(needsBrowser("帮我看下canvas上system engineering的group assessment要干嘛"), true);
  assert.equal(needsBrowser("通过b站学习断箭地图"), true);
  assert.equal(needsBrowser("看看学校网站上的最新通知"), true);
  assert.equal(needsBrowser("登录课程网页查看作业"), true);
});

test("needsBrowser recognizes URLs, English intents, and explicit web marker", () => {
  assert.equal(needsBrowser("打开这个网址：https://example.com"), true);
  assert.equal(needsBrowser("Browse this website and summarize the web page online"), true);
  assert.equal(needsBrowser("[web] 查看课程公告"), true);
});

test("needsBrowser leaves local-only tasks on the assist capability", () => {
  assert.equal(needsBrowser("帮我在本地找下 XX 文件"), false);
  assert.equal(needsBrowser("查一下电脑上的项目文件"), false);
});
