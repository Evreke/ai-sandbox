/**
 * pi-delegate — src/transport.ts (W4 seam split: FULL RE-EXPORT SHIM).
 *
 * MODULE_CONTRACT: transition shim only. The workerhost seam split (PoC,
 * design-host-interface.md migration steps 1–2) moved the backend-neutral
 * seam + contracts into src/host.ts and the herdr implementation into
 * src/herdr/host.ts — both byte-verbatim. This module re-exports BOTH so the
 * existing import graph (spawn/observe/fleet/exchange/usage → ./transport.ts,
 * index.ts binding) stays untouched and the suite stays green with zero
 * behavior change. The shim dies in migration step 6 (binding swap).
 *
 * Dependency rule (unchanged): tool modules import the seam from HERE and
 * never ./herdr/host.ts directly (pinned by static-check T1.1 / the positive
 * pin / watcher-check W1.1).
 */

export * from "./host.ts";
export * from "./herdr/host.ts";
