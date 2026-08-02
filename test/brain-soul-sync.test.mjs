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
