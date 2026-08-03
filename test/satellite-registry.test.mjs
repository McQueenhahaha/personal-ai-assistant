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
  const env = {
    WINDOWS_SSH_HOST: "tester@100.64.0.20",
    WINDOWS_SSH_KEY: "~/.ssh/pai_windows"
  };
  const registry = nodeRegistry({ brainNodeId: "mac", env });

  assert.deepEqual(registry.windows.capabilities, [
    "files", "browser", "screen", "canvas", "outlook", "maintenance", "codex", "gui-control"
  ]);
  assert.deepEqual(registry.mac.capabilities, ["files", "canvas", "codex", "gui-control"]);
  assert.equal(registry.mac.brain, true);
  assert.equal(registry.mac.local, true);
  assert.equal(registry.windows.brain, false);
  assert.equal(registry.windows.dispatchable, true);
  assert.deepEqual(registry.windows.ssh, {
    host: env.WINDOWS_SSH_HOST,
    keyEnv: "WINDOWS_SSH_KEY",
    agentKind: "windows"
  });
  assert.deepEqual(registry.mac.ssh, {
    host: "",
    keyEnv: "MAC_SATELLITE_KEY",
    agentKind: "mac"
  });
  assert.deepEqual(nodesFor("outlook", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("maintenance", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("browser", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("screen", { brainNodeId: "mac" }), ["windows"]);
  assert.deepEqual(nodesFor("codex", { brainNodeId: "mac" }), ["mac", "windows"]);
});

test("Mac brain reports an offline Windows node and selects it once reachable", async () => {
  const offline = await pickNode("outlook", {
    brainNodeId: "mac",
    probe: async () => false
  });
  assert.equal(offline.nodeId, null);
  assert.match(offline.reason, /Windows 不可达或受限代理未响应/);

  const online = await pickNode("screen", {
    brainNodeId: "mac",
    probe: async () => true
  });
  assert.equal(online.nodeId, "windows");
  assert.match(online.reason, /Windows在线且具备 screen 能力/);
});
