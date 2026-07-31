import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTask, TIER } from "../src/security/policy.mjs";

test("classifyTask recognizes read-only tasks as T0", () => {
  assert.equal(classifyTask("帮我在本地找下 system engineering 第二周的资料").tier, TIER.READONLY);
  assert.equal(classifyTask("Read the README and explain what it says").tier, TIER.READONLY);
  assert.equal(classifyTask("帮我看这份材料").tier, TIER.READONLY);
});

test("classifyTask defaults ordinary and project write tasks to T1", () => {
  assert.equal(classifyTask("整理项目里的 study notes").tier, TIER.SANDBOX);
  assert.equal(classifyTask("查看后修改项目内 README 的错别字").tier, TIER.SANDBOX);
  assert.equal(classifyTask("Run the test suite").tier, TIER.SANDBOX);
});

test("classifyTask recognizes privileged tasks as T2 before T1 or T0", () => {
  assert.equal(classifyTask("帮我安装一个软件").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("查看一下如何 install this package").tier, TIER.PRIVILEGED);
  assert.equal(classifyTask("请修改注册表启动项，然后点击确认按钮").tier, TIER.PRIVILEGED);
});

test("classifyTask recognizes forbidden tasks as T3 before T2", () => {
  assert.equal(classifyTask("安装软件后给供应商转账").tier, TIER.FORBIDDEN);
  assert.equal(classifyTask("Please disable Windows Defender").tier, TIER.FORBIDDEN);
  assert.equal(classifyTask("把 D:\\AI 下所有文件删掉").tier, TIER.FORBIDDEN);
});
