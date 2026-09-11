/**
 * pi-delegate — commands: the /delegate-fleet + /delegate-teardown commands —
 * extracted verbatim from observe.ts (Wave 3, audit Law 5: modules are
 * responsibilities; the code's own history: verbatim move from index.ts in
 * W6 — ex src/commands.ts, absorbed there in W5).
 * <p>
 * MODULE_CONTRACT: registers the two user-invoked commands (exact names,
 * frozen surface). /delegate-fleet opens the mission-control overlay
 * (headless → no-op); /delegate-teardown confirms, then tears workers down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport), pre-logging every planned op to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 * Dependencies: fleet.ts (buildWorkerView + overlay/dispose), expaths.ts +
 * exchange.ts (the shared teardown-audit trail helpers), host.ts (the
 * Transport seam + DelegateError), watcher.ts (errText — one spelling until
 * step 4 moves it to tool-result.ts). The watcher/teardown state these
 * commands drive lives in watcher.ts (mount registry) and fleet.ts (UI
 * mount registry).
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { TEARDOWN_LOG_NAME } from "./expaths.ts";
import { teardownLogLine } from "./exchange.ts";
import { buildWorkerView, disposeFleetUI, openFleetOverlay } from "./fleet.ts";
// Wave 3 decomposition (step 4): errText lives in src/tool-result.ts — the
// commands copy is deleted (audit finding 7, one definition per helper).
import { asDelegateError, errText } from "./tool-result.ts";
import { type DelegateError, type Transport } from "./host.ts";

// ===========================================================================
// SECTION 3/3 — /delegate-fleet + /delegate-teardown commands
// (verbatim move from index.ts in W6 — ex src/commands.ts, absorbed there in
// W5; this module owns the watcher/teardown state these commands drive. The
// commands.ts errText copy is NOT re-duplicated: observe already has an
// identical errText (watcher loop), so the moved code uses that one.)
// ===========================================================================

/**
 * Interactive teardown: lists workers, confirms, then tears each down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport). Every planned op is pre-logged to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 */

async function logTo(dir: string, line: string): Promise<void> {
	try {
		await appendFile(join(dir, TEARDOWN_LOG_NAME), teardownLogLine(line));
	} catch {
		// best-effort audit log — never block teardown on logging failure
	}
}

export function registerCommands(pi: import("@earendil-works/pi-coding-agent").ExtensionAPI, transport: Transport) {
	pi.registerCommand("delegate-fleet", {
		description: "Mission-control overlay: live worker fleet status, reports, mailbox, budget burn (read-only)",
		async handler(_args, ctx) {
			// Headless guard (pi docs Mode Behavior, same pattern as mountFleetUI):
			// the overlay is a TUI surface and the non-TUI early return in
			// openFleetOverlay would notify into a UI that is not there.
			if (!ctx.hasUI || !ctx.ui) return; // headless → no-op
			await openFleetOverlay(ctx, { transport });
		},
	});

	pi.registerCommand("delegate-teardown", {
		description: "Confirm + sequentially tear down all delegate workers (pre-logged, never automatic)",
		async handler(_args, ctx) {
			// Headless guard (pi docs Mode Behavior): the confirm/notify dialogs
			// below need a UI, and a headless session must NOT auto-confirm a
			// destructive teardown — refuse with a text-only note instead (console
			// is the headless channel, same as the watcher sink).
			if (!ctx.hasUI || !ctx.ui) {
				console.error(
					"[pi-delegate] /delegate-teardown needs a UI session (it confirms before tearing down) — run it in the interactive session that owns the workers.",
				);
				return;
			}
			const views = await buildWorkerView(transport);
			if (views.length === 0) {
				ctx.ui.notify("No delegate workers to tear down.", "info");
				// Nothing left to observe — also clear the ambient fleet UI (restore
				// footer) so no stale chip/widget survives an empty fleet.
				disposeFleetUI();
				return;
			}

			// Manifest history vs actionable workers (UX fix, 2026-09-10): manifest
			// worker entries are NEVER deleted, so the scan returns every worker
			// ever spawned — the wall of “✗ tab_not_found” for long-closed workers
			// looked like a catastrophe while meaning “nothing to close”. Retired
			// entries are HISTORY: skipped with a count, never attempted.
			const retiredViews = views.filter((v) => v.retired === true);
			const actionable = views.filter((v) => v.retired !== true);
			if (actionable.length === 0) {
				ctx.ui.notify(
					`Nothing to tear down — all ${views.length} manifest entries are retired history.`,
					"info",
				);
				disposeFleetUI();
				return;
			}

			const list = actionable
				.map((v) => `${v.name} (${v.kind}${v.branch ? `, branch ${v.branch}` : ""})`)
				.join(", ");
			const retiredNote = retiredViews.length > 0 ? ` (plus ${retiredViews.length} retired history entries skipped)` : "";
			const confirmed = await ctx.ui.confirm(
				"Tear down delegate workers?",
				`${actionable.length} worker(s): ${list}${retiredNote}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Teardown cancelled — workers left running.", "info");
				return;
			}

			const outcomes: string[] = [];
			for (const v of actionable) {
				// Pre-log the planned mutating op BEFORE executing it (audit trail).
				await logTo(
					v.dir,
					`plan: teardown worker=${v.name} kind=${v.kind} workspace=${v.placement.workspaceId ?? "-"} pane=${v.placement.paneId ?? "-"}`,
				);
				try {
					// EXTERNAL_DEPENDENCY: herdr teardown via the injected transport
					// (mutating pane/workspace IPC — the only mutating call here).
					// Migration stage 1 (extensibility-defect 1): the "already gone"
					// case is the structured alreadyGone field on the RESULT (before
					// this: a thrown error matched by the isAlreadyGone message regex).
					const res = await transport.teardown({ name: v.name, placement: v.placement, force: true });
					if (res?.alreadyGone) {
						await logTo(v.dir, `done: teardown worker=${v.name} no-op (already gone)`);
						outcomes.push(`✓ ${v.name} (${v.kind}) — already closed, no-op`);
						continue;
					}
					await logTo(v.dir, `done: teardown worker=${v.name} ok`);
					outcomes.push(`✓ ${v.name} (${v.kind}) torn down`);
				} catch (err) {
					// A throw is now ALWAYS a genuine failure (not-found shapes resolve
					// as alreadyGone inside the adapters) — parity with the retire pass.
					await logTo(v.dir, `error: teardown worker=${v.name} failed: ${errText(err)}`);
					const de = asDelegateError(err);
					const advice = de?.guidance
						? ` — ${de.guidance}`
						// No structured guidance: fall back to the generic recovery recipe.
						// Migration stage 3 (audit step 9): no herdr token in the hint —
						// the wt-directory refusal itself is the structured E_PLACE signal
						// raised at the segment boundary (expaths.isDirUnder, Windows fix);
						// backend-specific CLI tokens never reach the model-facing text.
						: " — reconcile via /delegate-teardown; for a worktree-link failure, recover via the host workspace listing/close.";
					outcomes.push(`✗ ${v.name}: ${errText(err)}${advice}`);
				}
			}

			// Teardown emptied the fleet: clear the ambient widget + restore the
			// default footer via the module-level mount registry in fleet.ts
			// (DESIGN.md §19.4 — the mount registry is documented in report-impl-ui.json).
			disposeFleetUI();
			ctx.ui.notify(`Teardown finished:\n${outcomes.join("\n")}`, "info");
		},
	});
}
