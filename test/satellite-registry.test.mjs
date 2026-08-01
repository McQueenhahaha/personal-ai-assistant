import { test } from "node:test";
import assert from "node:assert/strict";
import { nodeRegistry, nodeStatus, nodesFor, pickNode } from "../src/satellite/registry.mjs";

test("nodesFor returns the maintained preference order for every capability", () => {
  const options = { brainNodeId: "windows" };
  assert.deepEqual(nodesFor("gui-control", options), ["mac", "windows"]);
  assert.deepEqual(nodesFor("outlook", options), ["windows"]);
  assert.deepEqual(nodesFor("maintenance", options), ["windows"]);
  for (const capability of ["canvas", "files", "codex"]) {
    assert.deepEqual(nodesFor(capability, options), ["windows", "mac"]);
  }
  assert.deepEqual(nodesFor("browser", options), ["windows"]);
  assert.deepEqual(nodesFor("screen", options), ["windows"]);
});

test("nodeStatus treats self as online without probing", async () => {
  let probes = 0;
  const status = await nodeStatus("mac", {
    selfId: "mac",
    probes: {
      mac: async () => {
        probes += 1;
        return false;
      }
    }
  });

  assert.deepEqual(status, { online: true, self: true });
  assert.equal(probes, 0);
});

test("nodeStatus probes remote nodes and treats probe failures as offline", async () => {
  let probes = 0;
  const online = await nodeStatus("windows", {
    selfId: "mac",
    probes: {
      windows: async () => {
        probes += 1;
        return true;
      }
    }
  });
  const offline = await nodeStatus("windows", {
    selfId: "mac",
    probes: {
      windows: async () => {
        probes += 1;
        throw new Error("unreachable");
      }
    }
  });

  assert.deepEqual(online, { online: true, self: false });
  assert.deepEqual(offline, { online: false, self: false });
  assert.equal(probes, 2);
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
  assert.deepEqual(probed, ["mac"]);
});

test("pickNode never lets an injected probe mark self offline", async () => {
  const probed = [];
  const selection = await pickNode("browser", {
    brainNodeId: "windows",
    probe: async (nodeId) => {
      probed.push(nodeId);
      return false;
    }
  });

  assert.equal(selection.nodeId, "windows");
  assert.deepEqual(probed, []);
});

test("Mac brain registry marks itself local and keeps Windows-only capabilities off Mac", () => {
  const registry = nodeRegistry({ brainNodeId: "mac" });

  assert.deepEqual(registry.windows.capabilities, [
    "files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"
  ]);
  assert.deepEqual(registry.mac.capabilities, ["files", "canvas", "codex", "gui-control"]);
  assert.equal(registry.mac.brain, true);
  assert.equal(registry.mac.local, true);
  assert.equal(registry.windows.brain, false);
  assert.equal(registry.windows.dispatchable, false);
  assert.deepEqual(nodesFor("outlook", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("maintenance", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("browser", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("screen", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("codex", { brainNodeId: "mac" }), ["mac", "windows"]);
});

test("Mac brain honestly reports an offline or unreachable Windows-only capability", async () => {
  const offline = await pickNode("outlook", {
    brainNodeId: "mac",
    probe: async () => false
  });
  assert.equal(offline.nodeId, null);
  assert.match(offline.reason, /这个功能需要另一台电脑，它当前离线/);

  const onlineWithoutRoute = await pickNode("screen", {
    brainNodeId: "mac",
    probe: async () => true
  });
  assert.equal(onlineWithoutRoute.nodeId, null);
  assert.match(onlineWithoutRoute.reason, /Windows 没有 SSH 服务端/);
});
