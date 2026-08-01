import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  pullSoul,
  pushSoul,
  SOUL_FILES
} from "../src/brain/soul-sync.mjs";

const CONNECTION = {
  host: "tester@100.64.0.10",
  key: "C:\\keys\\pai_mac"
};

async function tempRepo(t) {
  const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "brain-soul-sync-"));
  t.after(() => fsPromises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("pushSoul builds one injection-safe scp call from existing soul files only", async (t) => {
  const repoRoot = await tempRepo(t);
  const present = [SOUL_FILES[0], SOUL_FILES.at(-1)];
  for (const relativeFile of present) {
    const file = path.join(repoRoot, relativeFile);
    await fsPromises.mkdir(path.dirname(file), { recursive: true });
    await fsPromises.writeFile(file, "{}", "utf8");
  }

  const calls = [];
  const result = await pushSoul(CONNECTION, {
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "scp");
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.slice(0, 6), [
    "-i",
    CONNECTION.key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new"
  ]);
  assert.deepEqual(calls[0].args.slice(6, -1), present.map((file) => path.join(repoRoot, file)));
  assert.equal(calls[0].args.at(-1), `${CONNECTION.host}:~/pai-satellite/soul/`);
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

test("pullSoul uses recursive scp, parses known files, and removes its temp directory", async () => {
  let pulledTempDir;
  const expectedLease = {
    holder: "mac",
    heartbeatAt: "2026-08-01T00:00:00.000Z",
    ttlSeconds: 90,
    reason: "renew"
  };
  const calls = [];

  const contents = await pullSoul(CONNECTION, {
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
    `${CONNECTION.host}:~/pai-satellite/soul/.`,
    pulledTempDir
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(fs.existsSync(pulledTempDir), false);
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

  await assert.rejects(
    pushSoul(CONNECTION, { repoRoot, spawnSync: fail }),
    /推送灵魂包失败：connection refused/
  );
  await assert.rejects(
    pullSoul(CONNECTION, { spawnSync: fail }),
    /拉取灵魂包失败：connection refused/
  );
});
