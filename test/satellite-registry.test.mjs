import { test } from "node:test";
import assert from "node:assert/strict";
import { nodesFor, pickNode } from "../src/satellite/registry.mjs";

test("nodesFor returns the maintained preference order for every capability", () => {
  assert.deepEqual(nodesFor("gui-control"), ["mac", "windows"]);
  assert.deepEqual(nodesFor("outlook"), ["windows"]);
  assert.deepEqual(nodesFor("maintenance"), ["windows"]);
  assert.deepEqual(nodesFor("canvas"), ["windows"]);
  for (const capability of ["files", "browser", "screen", "codex"]) {
    assert.deepEqual(nodesFor(capability), ["windows", "mac"]);
  }
});

test("pickNode falls back when the preferred node is offline", async () => {
  const probed = [];
  const selection = await pickNode("gui-control", {
    async probe(nodeId) {
      probed.push(nodeId);
      return nodeId === "windows";
    }
  });

  assert.equal(selection.nodeId, "windows");
  assert.deepEqual(probed, ["mac", "windows"]);
});

test("pickNode returns null when every candidate is offline", async () => {
  const selection = await pickNode("browser", { probe: async () => false });

  assert.equal(selection.nodeId, null);
  assert.match(selection.reason, /这台电脑不可用/);
  assert.match(selection.reason, /MacBook不可用/);
});
