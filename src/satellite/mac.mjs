import { dispatchToNode, satelliteHealth } from "./dispatch.mjs";

export function dispatchToMac(task, dependencies = {}) {
  return dispatchToNode("mac", task, dependencies);
}

export function macSatelliteHealth(dependencies = {}) {
  return satelliteHealth("mac", dependencies);
}
