import type { LSInstance } from "./discovery.js";

export function instanceHealthScore(inst: LSInstance): number {
  if (typeof inst.modelCount === "number") {
    return inst.modelCount > 0 ? 2 : 0;
  }
  return 1;
}

export function rankInstancesByHealth(instances: LSInstance[]): LSInstance[] {
  return [...instances].sort((a, b) => {
    const scoreDiff = instanceHealthScore(b) - instanceHealthScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.modelCount ?? -1) - (a.modelCount ?? -1);
  });
}
