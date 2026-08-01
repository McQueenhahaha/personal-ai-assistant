import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeRegistry, nodesFor, pickNode } from "../src/satellite/registry.mjs";

test("nodesFor returns the maintained preference order for every capability", () => {
  const options = { brainNodeId: "windows" };
  assert.deepEqual(nodesFor("gui-control", options), ["mac", "windows"]);
  assert.deepEqual(nodesFor("outlook", options), ["windows"]);
  assert.deepEqual(nodesFor("maintenance", options), ["windows"]);
  assert.deepEqual(nodesFor("canvas", options), ["windows"]);
  for (const capability of ["files", "browser", "screen", "codex"]) {
    assert.deepEqual(nodesFor(capability, options), ["windows", "mac"]);
  }
});

test("pickNode falls back when the preferred node is offline", async () => {
  const probed = [];
  const selection = await pickNode("gui-control", {
    brainNodeId: "windows",
    async probe(nodeId) {
      probed.push(nodeId);
      return nodeId === "windows";
    }
  });

  assert.equal(selection.nodeId, "windows");
  assert.deepEqual(probed, ["mac", "windows"]);
});

test("pickNode returns null when every candidate is offline", async () => {
  const selection = await pickNode("browser", {
    brainNodeId: "windows",
    probe: async () => false
  });

  assert.equal(selection.nodeId, null);
  assert.match(selection.reason, /这台电脑不可用/);
  assert.match(selection.reason, /Mac不可用/);
});

test("Mac brain registry marks itself local and keeps Windows-only capabilities off Mac", () => {
  const registry = nodeRegistry({ brainNodeId: "mac" });

  assert.equal(registry.mac.brain, true);
  assert.equal(registry.mac.local, true);
  assert.equal(registry.windows.brain, false);
  assert.equal(registry.windows.dispatchable, false);
  assert.equal(registry.mac.capabilities.includes("browser"), false);
  assert.equal(registry.mac.capabilities.includes("screen"), false);
  assert.deepEqual(nodesFor("outlook", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("maintenance", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("browser", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("screen", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("codex", { brainNodeId: "mac" }), ["mac"]);
});

test("Mac brain honestly reports an offline or unreachable Windows-only capability", async () => {
  const offline = await pickNode("outlook", {
    brainNodeId: "mac",
    probe: async () => false
  });
  assert.equal(offline.nodeId, null);
  assert.match(offline.reason, /这个功能需要 Windows，但它当前离线/);

  const onlineWithoutRoute = await pickNode("screen", {
    brainNodeId: "mac",
    probe: async () => true
  });
  assert.equal(onlineWithoutRoute.nodeId, null);
  assert.match(onlineWithoutRoute.reason, /Windows 没有 SSH 服务端/);
});
