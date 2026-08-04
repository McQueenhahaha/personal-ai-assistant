import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutionPrompt, validateTask } from "../satellite/mac-agent.mjs";
import { dispatchToMac, macSatelliteHealth } from "../src/satellite/mac.mjs";

const ENV = {
  // 这组用例讲的是"Windows 把活派给 Mac"，所以必须写明自己是 Windows。
  // 不写的话 selfId 回落到宿主平台：在 Linux CI 上会解析成 mac，
  // 于是"派给 mac"被判成"派给自己"而拒绝走 SSH。
  BRAIN_NODE_ID: "windows",
  MAC_SATELLITE_HOST: "tester@100.64.0.10",
  MAC_SATELLITE_KEY: "C:\\keys\\pai_mac"
};
const HOME = "C:\\Users\\tester";
const ID = "11111111-2222-4333-8444-555555555555";
const STARTED_AT = "2026-08-01T00:00:01.000Z";
const FINISHED_AT = "2026-08-01T00:00:02.000Z";

function dependencies(spawnSyncImpl, overrides = {}) {
  return {
    spawnSync: spawnSyncImpl,
    env: ENV,
    homedir: () => HOME,
    randomUUID: () => ID,
    sleep: async () => {},
    now: () => 0,
    ...overrides
  };
}

test("Mac agent validates the exact task shape and prefixes only computer-use prompts", () => {
  const task = {
    id: ID,
    prompt: "查看当前桌面",
    kind: "mac-computer-use",
    createdAt: STARTED_AT,
    timeoutMs: 600000
  };

  assert.equal(validateTask(task, ID), "");
  assert.match(validateTask({ ...task, extra: true }, ID), /字段必须严格/);
  assert.match(validateTask({ ...task, id: "other" }, ID), /文件名一致/);
  const protectedPrompt = buildExecutionPrompt(task);
  assert.match(protectedPrompt, /不要读取或外发任何凭据、密码、token、cookie/);
  assert.match(protectedPrompt, /不要付款、转账、改账号安全设置/);
  assert.equal(protectedPrompt.endsWith(task.prompt), true);
  assert.equal(buildExecutionPrompt({ ...task, kind: "mac-general" }), task.prompt);
});

test("dispatchToMac uploads with argument arrays, polls, parses, and cleans up", async () => {
  const calls = [];
  let uploadedTask;
  let catCalls = 0;
  const expectedResult = {
    id: ID,
    ok: true,
    result: "完成",
    error: "",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT
  };
  const fakeSpawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "scp") {
      uploadedTask = JSON.parse(fs.readFileSync(args.at(-2), "utf8"));
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args.includes("cat")) {
      catCalls += 1;
      return catCalls === 1
        ? { status: 1, stdout: "", stderr: "cat: No such file or directory" }
        : { status: 0, stdout: JSON.stringify(expectedResult), stderr: "" };
    }
    if (args.includes("rm")) return { status: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
  };

  const actual = await dispatchToMac({
    prompt: "在 Mac 上查看桌面",
    kind: "mac-computer-use",
    timeoutMs: 1000
  }, dependencies(fakeSpawnSync));

  assert.deepEqual(actual, expectedResult);
  assert.deepEqual(uploadedTask, {
    id: ID,
    prompt: "在 Mac 上查看桌面",
    kind: "mac-computer-use",
    createdAt: "1970-01-01T00:00:00.000Z",
    timeoutMs: 1000
  });
  assert.equal(calls[0].command, "scp");
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 6), [
    "-i",
    path.resolve(ENV.MAC_SATELLITE_KEY),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ]);
  assert.equal(calls[0].args.at(-1), `${ENV.MAC_SATELLITE_HOST}:pai-satellite/inbox/${ID}.json`);
  assert.equal(calls.every(({ args }) => !args.includes("在 Mac 上查看桌面")), true);
  assert.deepEqual(calls.at(-1).args.slice(-4), [
    ENV.MAC_SATELLITE_HOST,
    "rm",
    "-f",
    `pai-satellite/outbox/${ID}.json`
  ]);
});

test("dispatchToMac returns the fetched result when remote cleanup fails", async () => {
  const logs = [];
  const expectedResult = {
    id: ID,
    ok: true,
    result: "done",
    error: "",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT
  };
  const fakeSpawnSync = (command, args) => {
    if (command === "scp") return { status: 0, stdout: "", stderr: "" };
    if (args.includes("cat")) {
      return { status: 0, stdout: JSON.stringify(expectedResult), stderr: "" };
    }
    if (args.includes("rm")) {
      return { status: 255, stdout: "", stderr: "connection reset" };
    }
    throw new Error("unexpected call");
  };

  const actual = await dispatchToMac(
    { prompt: "test", kind: "mac-general" },
    dependencies(fakeSpawnSync, { logError: (line) => { logs.push(line); } })
  );

  assert.deepEqual(actual, expectedResult);
  assert.equal(logs.length, 1);
  assert.match(logs[0], new RegExp(`pai-satellite/outbox/${ID}\\.json`));
  assert.match(logs[0], /connection reset/);
});

test("dispatchToMac times out after task timeout plus SSH grace", async () => {
  let clock = 0;
  const calls = [];
  const fakeSpawnSync = (command, args) => {
    calls.push({ command, args });
    if (command === "scp") return { status: 0, stdout: "", stderr: "" };
    return { status: 1, stdout: "", stderr: "cat: No such file or directory" };
  };

  await assert.rejects(
    dispatchToMac({ prompt: "test", kind: "mac-general", timeoutMs: 1000 }, dependencies(fakeSpawnSync, {
      now: () => clock,
      sleep: async (ms) => { clock += ms; }
    })),
    /等待 Mac 卫星结果超时.*61000ms/
  );
  assert.equal(calls.some(({ args }) => args.includes("rm")), false);
});

test("dispatchToMac cleanup failure does not mask a result parsing error", async () => {
  const calls = [];
  const logs = [];
  const fakeSpawnSync = (command, args) => {
    calls.push({ command, args });
    if (command === "scp") return { status: 0, stdout: "", stderr: "" };
    if (args.includes("cat")) return { status: 0, stdout: "not-json", stderr: "" };
    if (args.includes("rm")) return { status: 255, stdout: "", stderr: "cleanup failed" };
    throw new Error("unexpected call");
  };

  await assert.rejects(
    dispatchToMac(
      { prompt: "test", kind: "mac-general" },
      dependencies(fakeSpawnSync, { logError: (line) => { logs.push(line); } })
    ),
    /无效 JSON/
  );
  assert.equal(calls.some(({ args }) => args.includes("rm")), true);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cleanup failed/);
});

test("dispatchToMac reports scp failure and returns a remote task failure", async () => {
  await assert.rejects(
    dispatchToMac({ prompt: "test", kind: "mac-general" }, dependencies(() => ({
      status: 255,
      stdout: "",
      stderr: "connection refused"
    }))),
    /投递 Mac 卫星任务失败：connection refused/
  );

  const failedResult = {
    id: ID,
    ok: false,
    result: "",
    error: "Codex 启动失败",
    startedAt: STARTED_AT,
    finishedAt: FINISHED_AT
  };
  const fakeSpawnSync = (command, args) => {
    if (command === "scp" || args.includes("rm")) return { status: 0, stdout: "", stderr: "" };
    return { status: 0, stdout: JSON.stringify(failedResult), stderr: "" };
  };
  assert.deepEqual(
    await dispatchToMac({ prompt: "test", kind: "mac-general" }, dependencies(fakeSpawnSync)),
    failedResult
  );
});

test("macSatelliteHealth distinguishes running, stopped, and offline states", async () => {
  let calls = 0;
  const running = await macSatelliteHealth(dependencies(() => {
    calls += 1;
    return { status: 0, stdout: calls === 2 ? "123\n" : "", stderr: "" };
  }));
  assert.deepEqual(running, {
    ok: true,
    online: true,
    agentRunning: true,
    host: ENV.MAC_SATELLITE_HOST
  });

  calls = 0;
  const stopped = await macSatelliteHealth(dependencies(() => {
    calls += 1;
    return calls === 1
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 1, stdout: "", stderr: "" };
  }));
  assert.equal(stopped.online, true);
  assert.equal(stopped.agentRunning, false);
  assert.match(stopped.error, /代理未运行/);

  const offline = await macSatelliteHealth(dependencies(() => ({
    status: 255,
    stdout: "",
    stderr: "No route to host"
  })));
  assert.equal(offline.online, false);
  assert.match(offline.error, /No route to host/);

  calls = 0;
  const disconnectedDuringProcessCheck = await macSatelliteHealth(dependencies(() => {
    calls += 1;
    return calls === 1
      ? { status: 0, stdout: "", stderr: "" }
      : { status: 255, stdout: "", stderr: "Connection reset" };
  }));
  assert.equal(disconnectedDuringProcessCheck.online, false);
  assert.match(disconnectedDuringProcessCheck.error, /Connection reset/);
});

test("macSatelliteHealth reports the placeholder when MAC_SATELLITE_HOST is missing", async () => {
  const health = await macSatelliteHealth({
    env: {},
    homedir: () => HOME
  });

  assert.equal(health.online, false);
  assert.match(health.error, /user@100\.x\.y\.z/);
  assert.match(health.error, /\.env 配置实际的 SSH 目标/);
});
