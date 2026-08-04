import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pullSoul,
  pushSoul,
  readSoulLease,
  SOUL_FILES
} from "../src/brain/soul-sync.mjs";

const CONNECTION = {
  host: "tester@100.64.0.10",
  key: "C:\\keys\\pai_mac"
};
const BACKUP_TIMESTAMP = "2026-08-01T00-02-00-000Z";

async function tempRepo(t) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "brain-soul-sync-"));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("pushSoul backs up the remote state before its injection-safe scp call", async (t) => {
  const repoRoot = await tempRepo(t);
  const present = [SOUL_FILES[0], SOUL_FILES.at(-1)];
  for (const relativeFile of present) {
    const file = path.join(repoRoot, relativeFile);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.writeFile(file, "{}", "utf8");
  }

  const calls = [];
  const result = await pushSoul(CONNECTION, {
    backupTimestamp: BACKUP_TIMESTAMP,
    repoRoot,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.deepEqual(result.pushed, [
    "openclaw-telegram-bridge-state.json",
    "brain-lease.json"
  ]);
  assert.equal(result.backupPath, `~/pai-brain/data/state-backup/${BACKUP_TIMESTAMP}/`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.at(-2), CONNECTION.host);
  assert.match(calls[0].args.at(-1), new RegExp(`state-backup/${BACKUP_TIMESTAMP}`));
  assert.equal(calls[1].command, "scp");
  assert.equal(calls[1].options.shell, false);
  assert.deepEqual(calls[1].args.slice(0, 6), [
    "-i",
    CONNECTION.key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ]);
  assert.deepEqual(calls[1].args.slice(6, -1), present.map((file) => path.join(repoRoot, file)));
  assert.equal(calls[1].args.at(-1), `${CONNECTION.host}:~/pai-brain/data/state/`);
});

test("pushSoul skips missing files and does not spawn scp when none exist", async (t) => {
  const repoRoot = await tempRepo(t);
  let calls = 0;

  const result = await pushSoul(CONNECTION, {
    repoRoot,
    spawnSync: () => {
      calls += 1;
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.deepEqual(result, { pushed: [] });
  assert.equal(calls, 0);
});

test("pullSoul backs up local state, overwrites it from Mac, and removes its temp directory", async (t) => {
  const repoRoot = await tempRepo(t);
  let pulledTempDir;
  const localLease = {
    holder: "windows",
    heartbeatAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 90,
    reason: "renew"
  };
  const expectedLease = {
    holder: "mac",
    heartbeatAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 90,
    reason: "renew"
  };
  const calls = [];
  const leaseFile = path.join(repoRoot, "data", "state", "brain-lease.json");
  await fsPromises.mkdir(path.dirname(leaseFile), { recursive: true });
  await fsPromises.writeFile(leaseFile, JSON.stringify(localLease), "utf8");

  const contents = await pullSoul(CONNECTION, {
    repoRoot,
    spawnSync: (command, args, options) => {
      calls.push({ command, args, options });
      pulledTempDir = args.at(-1);
      fs.writeFileSync(
        path.join(pulledTempDir, "brain-lease.json"),
        JSON.stringify(expectedLease),
        "utf8"
      );
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.deepEqual(contents, {
    "data/state/brain-lease.json": expectedLease
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(-3), [
    "-r",
    `${CONNECTION.host}:~/pai-brain/data/state/.`,
    pulledTempDir
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(fs.existsSync(pulledTempDir), false);
  assert.deepEqual(JSON.parse(await fsPromises.readFile(leaseFile, "utf8")), expectedLease);
  assert.deepEqual(
    JSON.parse(await fsPromises.readFile(path.join(repoRoot, "data", "state", ".backup", "brain-lease.json"), "utf8")),
    localLease
  );
});

test("readSoulLease reads only the Mac project lease over Windows-initiated SSH", async () => {
  const expectedLease = {
    holder: "mac",
    heartbeatAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 90,
    reason: "renew"
  };
  const calls = [];

  const result = await readSoulLease(CONNECTION, {
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify(expectedLease), stderr: "" };
    }
  });

  assert.deepEqual(result, expectedLease);
  assert.equal(calls[0].command, "ssh");
  assert.deepEqual(calls[0].args.slice(-3), [
    CONNECTION.host,
    "cat",
    "~/pai-brain/data/state/brain-lease.json"
  ]);
  assert.equal(calls[0].options.shell, false);
});

test("pushSoul and pullSoul surface clear scp failures", async (t) => {
  const repoRoot = await tempRepo(t);
  const file = path.join(repoRoot, SOUL_FILES[0]);
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, "{}", "utf8");
  const fail = () => ({
    status: 255,
    stdout: "",
    stderr: "connection refused"
  });
  const pushCommands = [];

  await assert.rejects(
    pushSoul(CONNECTION, {
      backupTimestamp: BACKUP_TIMESTAMP,
      repoRoot,
      spawnSync: (command) => {
        pushCommands.push(command);
        return fail();
      }
    }),
    /备份远端灵魂包失败：connection refused/
  );
  assert.deepEqual(pushCommands, ["ssh"]);
  await assert.rejects(
    pullSoul(CONNECTION, { repoRoot, spawnSync: fail }),
    /拉取灵魂包失败：connection refused/
  );
});

test("灵魂包里单个文件不合法时跳过它，而不是让整包都落不了地", async (t) => {
  // 原先只要有一个文件 JSON.parse 失败或内容离谱，pullSoul 就整批抛错 ——
  // 另外九个正常文件也同步不过来。与桥那个 offset 毒丸是同一个毛病。
  const repoRoot = await tempRepo(t);
  const localOffset = { offset: 4242 };
  const offsetFile = path.join(repoRoot, "data", "state", "telegram-update-offset.json");
  await fsPromises.mkdir(path.dirname(offsetFile), { recursive: true });
  await fsPromises.writeFile(offsetFile, JSON.stringify(localOffset), "utf8");

  const warnings = [];
  const goodLease = {
    holder: "mac",
    heartbeatAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 90,
    reason: "renew"
  };

  const contents = await pullSoul(CONNECTION, {
    repoRoot,
    logger: { warn: (message) => warnings.push(message) },
    spawnSync: (command, args) => {
      const tempDir = args.at(-1);
      // 远端这份 offset 是坏的：负数会让桥把全部历史消息重放一遍。
      fs.writeFileSync(
        path.join(tempDir, "telegram-update-offset.json"),
        JSON.stringify({ offset: -1 }),
        "utf8"
      );
      fs.writeFileSync(
        path.join(tempDir, "brain-lease.json"),
        JSON.stringify(goodLease),
        "utf8"
      );
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  assert.equal(contents["data/state/telegram-update-offset.json"], undefined, "坏文件不该被采纳");
  assert.deepEqual(contents["data/state/brain-lease.json"], goodLease, "正常文件必须照常落地");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(offsetFile, "utf8")),
    localOffset,
    "本地 offset 不该被坏数据覆盖"
  );
  // 跳过必须出声，否则就是"看着同步成功、其实少了东西"。
  assert.match(warnings.join(" "), /未采纳/);
});
