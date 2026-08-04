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

test("带链接的提问不该被当成「操作项目目录以外的路径」", () => {
  // 路径正则里 [a-z]:[\\/] 会命中 "https://" 里的 "s:/" 和 "http://" 里的 "p:/"，
  // 于是任何带链接的消息都被判 T2、要手打 /ok，理由还是"你操作了项目外的路径"——
  // 而你根本没提过路径。/web 后面几乎一定跟 URL，这条命令因此等于废掉。
  assert.equal(
    classifyTask("看一下 https://example.com/article 这篇文章讲了什么").tier,
    TIER.READONLY
  );
  assert.equal(
    classifyTask("帮我看看 http://news.ycombinator.com 上有什么新闻").tier,
    TIER.READONLY
  );
  assert.equal(
    classifyTask("打开 https://rmit.instructure.com 看看有什么作业").tier,
    TIER.READONLY
  );
});

test("放宽之后，真实的项目外路径必须仍然是 T2", () => {
  // 上面那条是**放宽**安全判定，所以这组护栏必须与它同时存在：
  // 少了它，下次谁再动这条正则就没人拦得住。
  for (const text of [
    "读 D:/notes/a.md",
    "打开 C:\\Users\\user\\x.txt",
    "看 d:\\tools 里有什么",
    "访问 \\\\nas\\share",
    "读 %APPDATA%\\foo",
    "看 ~/notes 里的东西",
    "读 /etc/hosts",
    "读 ../secrets"
  ]) {
    assert.equal(classifyTask(text).tier, TIER.PRIVILEGED, text);
  }
});
