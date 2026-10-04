import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkPeerVersion, readPeerVersionState } from "../src/brain/peer-version.mjs";

const NOW_MS = Date.parse("2026-10-04T08:00:00.000Z");
const CONNECTION = { host: "tester@100.64.0.10", key: "C:\\keys\\pai_mac" };

function harness(t, { local, mac, sendResult = { sent: true } }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "peer-version-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  const versions = { local, mac };
  const dependencies = {
    peerConnection: CONNECTION,
    stateFile: path.join(directory, "peer-version.json"),
    readLocalVersion: async () => versions.local,
    readPeerVersion: async (connection) => {
      assert.deepEqual(connection, CONNECTION);
      return versions.mac;
    },
    sendTelegramMessage: async (text) => {
      sent.push(text);
      return sendResult;
    }
  };
  return { dependencies, sent, versions };
}

test("Mac drift alerts once, stays quiet while it persists, and announces the fix", async (t) => {
  const { dependencies, sent, versions } = harness(t, { local: "ad442d9", mac: null });

  await checkPeerVersion({ nowMs: NOW_MS }, dependencies);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /不一致/);
  assert.match(sent[0], /deploy-mac-brain\.ps1/);

  // 又提交了一次但还没部署：仍是「不一致」，不该再发。
  versions.local = "b1c2d3e";
  await checkPeerVersion({ nowMs: NOW_MS + 300_000 }, dependencies);
  assert.equal(sent.length, 1);

  versions.mac = "b1c2d3e";
  await checkPeerVersion({ nowMs: NOW_MS + 600_000 }, dependencies);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /已与 Windows 一致/);
  assert.deepEqual(readPeerVersionState(dependencies.stateFile), {
    local: "b1c2d3e",
    mac: "b1c2d3e",
    match: true,
    atMs: NOW_MS + 600_000
  });
});

test("a first check that finds both nodes aligned stays silent", async (t) => {
  const { dependencies, sent } = harness(t, { local: "ad442d9", mac: "ad442d9" });

  const result = await checkPeerVersion({ nowMs: NOW_MS }, dependencies);

  assert.deepEqual(result, { checked: true, match: true, alerted: false });
  assert.equal(sent.length, 0);
});

test("a failed alert is not recorded, so the next round retries it", async (t) => {
  const { dependencies, sent } = harness(t, { local: "ad442d9", mac: "622fb5c", sendResult: { sent: false, reason: "offline" } });

  await checkPeerVersion({ nowMs: NOW_MS }, dependencies);
  assert.equal(readPeerVersionState(dependencies.stateFile), null);

  dependencies.sendTelegramMessage = async (text) => {
    sent.push(text);
    return { sent: true };
  };
  await checkPeerVersion({ nowMs: NOW_MS + 300_000 }, dependencies);
  assert.equal(sent.length, 2);
});

test("nothing is checked without a configured Mac or a known local version", async (t) => {
  const noPeer = harness(t, { local: "ad442d9", mac: "622fb5c" });
  noPeer.dependencies.peerConnection = null;
  noPeer.dependencies.readPeerVersion = async () => assert.fail("must not SSH without a configured Mac");
  assert.deepEqual(await checkPeerVersion({ nowMs: NOW_MS }, noPeer.dependencies), { checked: false });

  const noLocal = harness(t, { local: null, mac: "622fb5c" });
  assert.deepEqual(await checkPeerVersion({ nowMs: NOW_MS }, noLocal.dependencies), { checked: false });
  assert.equal(noLocal.sent.length, 0);
});

test("the peer connection comes from the injected env, so a bare env never reaches SSH", async () => {
  const result = await checkPeerVersion({ nowMs: NOW_MS }, {
    env: {},
    platform: "win32",
    readPeerVersion: async () => assert.fail("must not SSH without MAC_SATELLITE_HOST")
  });

  assert.deepEqual(result, { checked: false });
});
