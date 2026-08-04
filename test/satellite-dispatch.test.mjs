import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchToNode } from "../src/satellite/dispatch.mjs";

const MAC_ENV = {
  BRAIN_NODE_ID: "windows",
  MAC_SATELLITE_HOST: "tester@100.64.0.10",
  MAC_SATELLITE_KEY: "C:\\keys\\pai_mac"
};
const WINDOWS_ENV = {
  BRAIN_NODE_ID: "mac",
  WINDOWS_SSH_HOST: "tester@100.64.0.20",
  WINDOWS_SSH_KEY: "~/.ssh/pai_windows"
};
const TASK_ID = "11111111-2222-4333-8444-555555555555";

test("dispatchToNode executes self locally without starting SSH", async () => {
  const calls = [];
  const task = { kind: "screen", prompt: "查看屏幕", capability: "screen" };
  const result = await dispatchToNode("windows", task, {
    env: { BRAIN_NODE_ID: "windows" },
    spawnSync() {
      throw new Error("self dispatch must not use SSH");
    },
    async localExecute(received) {
      calls.push(received);
      return { ok: true, result: "local" };
    }
  });

  assert.deepEqual(result, { ok: true, result: "local" });
  assert.deepEqual(calls, [task]);
});

test("dispatchToNode rejects a target that lacks the required capability", async () => {
  await assert.rejects(
    dispatchToNode("mac", {
      kind: "screen",
      prompt: "查看 Windows 屏幕",
      capability: "screen"
    }, {
      env: MAC_ENV,
      spawnSync() {
        throw new Error("capability rejection must happen before SSH");
      }
    }),
    /Mac 节点缺少 screen 能力，拒绝派发/
  );
});

test("dispatchToNode keeps a valid Mac result when remote cleanup fails", async () => {
  const logs = [];
  const expected = {
    id: TASK_ID,
    ok: true,
    result: "done",
    error: "",
    startedAt: "2026-08-01T00:00:01.000Z",
    finishedAt: "2026-08-01T00:00:02.000Z"
  };
  const result = await dispatchToNode("mac", {
    kind: "mac-general",
    prompt: "test"
  }, {
    env: MAC_ENV,
    randomUUID: () => TASK_ID,
    now: () => 0,
    sleep: async () => {},
    spawnSync(command, args) {
      if (command === "scp") return { status: 0, stdout: "", stderr: "" };
      if (args.includes("cat")) return { status: 0, stdout: JSON.stringify(expected), stderr: "" };
      if (args.includes("rm")) return { status: 255, stdout: "", stderr: "cleanup failed" };
      throw new Error(`unexpected command: ${command}`);
    },
    logError(line) {
      logs.push(line);
    }
  });

  assert.deepEqual(result, expected);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cleanup failed/);
});

test("dispatchToNode sends Windows payload only through stdin and parses JSON", async () => {
  const calls = [];
  const prompt = "查看屏幕；不要放进命令行";
  const result = await dispatchToNode("windows", {
    kind: "screen",
    prompt,
    timeoutMs: 2000
  }, {
    env: WINDOWS_ENV,
    homedir: () => "C:\\Users\\tester",
    randomUUID: () => TASK_ID,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          node: "windows",
          taskId: TASK_ID,
          kind: "screen",
          result: "D:\\AI\\personal-ai-assistant\\data\\screenshots\\screen.png"
        }),
        stderr: ""
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls[0].args.at(-1), "run");
  assert.equal(calls[0].args.includes(prompt), false);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(JSON.parse(calls[0].options.input), {
    kind: "screen",
    prompt,
    taskId: TASK_ID,
    timeoutSeconds: 2
  });
  assert.equal(fs.existsSync(path.join(process.cwd(), "whoami")), false);
});

test("探活不得回退到 spawnSync —— 那会冻住桥的事件循环", () => {
  // /status 会 ssh 探对端，超时 15 秒；Mac 是笔记本、多数时间合着盖。
  // 用 spawnSync 的话，按一下菜单第一项就是 15~30 秒里桥对任何消息都没反应，
  // 连急停都按不下去 —— 与 runPowerShell 当初那个洞同形，只是换了条路径。
  //
  // 这条守卫盯的是"有人把它改回同步调用"。真实的非阻塞性没法在进程内断言：
  // 注入一个 async stub 只能证明 stub 是异步的，证明不了生产路径。
  const source = fs.readFileSync(
    new URL("../src/satellite/dispatch.mjs", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("export async function satelliteHealth");
  assert.ok(start > 0, "找不到 satelliteHealth");
  const end = source.indexOf("\nexport ", start + 1);
  const body = source.slice(start, end > 0 ? end : undefined);

  assert.equal(
    /spawnSync/.test(body),
    false,
    "satelliteHealth 里出现了 spawnSync —— 探活必须走异步 spawn"
  );
  assert.match(body, /probeImpl\(/, "探活必须经由可注入的 probe，测试才走得到生产同一条路");
});
