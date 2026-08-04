import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runGmailExport, runOutlookExport } from "../src/school/exporters.mjs";

function fakeSpawn(result) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return result;
  };
  return { calls, spawn };
}

test("runOutlookExport spawns the current PowerShell command and returns trimmed stdout", () => {
  const { calls, spawn } = fakeSpawn({ status: 0, stdout: "  outlook exported  \n", stderr: "" });

  const output = runOutlookExport(
    { days: 9, maxMessages: 42, syncWaitSeconds: 13 },
    { spawn }
  );

  assert.equal(output, "outlook exported");
  assert.deepEqual(calls, [
    {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.resolve("scripts", "export-outlook-mail.ps1"),
        "-Days",
        "9",
        "-MaxMessages",
        "42",
        "-SyncWaitSeconds",
        "13"
      ],
      options: {
        cwd: process.cwd(),
        encoding: "utf8"
      }
    }
  ]);
});

test("runGmailExport 直接调 gog，不再经过 PowerShell", () => {
  const { calls, spawn } = fakeSpawn({
    status: 0,
    stdout: "ID\tDATE\tFROM\tSUBJECT\n1\t2026-08-04\ta@b.com\t你好\n",
    stderr: ""
  });
  const writes = [];

  const output = runGmailExport(
    { maxMessages: 17, query: "from:test newer_than:2d", account: "demo@example.com" },
    {
      spawn,
      root: "/tmp/root",
      now: () => new Date("2026-08-04T01:52:27.123Z"),
      fs: { mkdirSync: () => {}, writeFileSync: (file, body) => writes.push({ file, body }) }
    }
  );

  // 参数以数组传递 —— query 再怎么写都只是一个 argv 元素，拼不成命令。
  assert.deepEqual(calls, [
    {
      command: "gog",
      args: [
        "gmail",
        "search",
        "from:test newer_than:2d",
        "--max",
        "17",
        "--plain",
        "--gmail-no-send",
        "--account",
        "demo@example.com"
      ],
      options: { encoding: "utf8" }
    }
  ]);

  // 文件名里不能有冒号，否则 Windows 上写不出来。
  assert.match(writes[0].file, /gmail-snapshot-2026-08-04T01-52-27Z\.md$/);
  assert.equal(output, `Exported Gmail snapshot to ${writes[0].file}`);

  // gog 的输出必须原样落在 ```text 块里，否则下游解析拿不到邮件。
  assert.match(
    writes[0].body,
    /```text\nID\tDATE\tFROM\tSUBJECT\n1\t2026-08-04\ta@b\.com\t你好\n```/
  );
  assert.match(writes[0].body, /^Subject: Gmail snapshot\nFrom: gog gmail\n/);
  assert.match(writes[0].body, /- Account: demo@example\.com/);
});

test("runOutlookExport preserves nonzero-status stderr failure behavior", () => {
  const { spawn } = fakeSpawn({
    status: 7,
    stdout: "stdout ignored",
    stderr: "  outlook stderr fail  \n"
  });

  assert.throws(
    () => runOutlookExport({ days: 1, maxMessages: 2, syncWaitSeconds: 3 }, { spawn }),
    { message: "outlook stderr fail" }
  );
});

test("找不到 gog 时说清楚该怎么装，而不是笼统地说失败", () => {
  // 这正是把导出搬到 Mac 时会撞上的第一个坎，错误信息必须能直接照做。
  const { spawn } = fakeSpawn({
    error: Object.assign(new Error("spawn gog ENOENT"), { code: "ENOENT" })
  });

  assert.throws(
    () => runGmailExport({ maxMessages: 4, query: "", account: "" }, { spawn }),
    /brew install gogcli/
  );
});

test("gog 非零退出时带出 stderr，但翻页提示不算错误", () => {
  const { spawn } = fakeSpawn({
    status: 3,
    stdout: "",
    // 两台机器的 gog 版本不同，翻页提示措辞也不同 —— 两种都不算错误。
    stderr:
      "auth expired for demo@example.com\n" +
      "# Next page:  --page CAUQ\n" +
      "# More results: use --all/--all-pages to fetch every page, or --page 1157\n"
  });

  assert.throws(
    () => runGmailExport({ maxMessages: 4, query: "", account: "" }, { spawn }),
    (error) =>
      /auth expired for demo@example\.com/.test(error.message) &&
      !/Next page/.test(error.message) &&
      !/More results/.test(error.message)
  );
});
