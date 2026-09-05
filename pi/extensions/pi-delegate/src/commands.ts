/**
 * pi-delegate — `/delegate-teardown` command (DESIGN.md §5.3).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * Interactive teardown: lists workers, confirms, then tears each down
 * SEQUENTIALLY (one mutating op at a time is also enforced inside the
 * transport). Every planned op is pre-logged to <exchange dir>/teardown.log
 * before it runs. Never runs on its own — user-invoked command only.
 */

import { appendFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openFleetOverlay } from "./ui/fleet.ts";
import { disposeFleetUI } from "./ui/fleet-ui.ts";
import { buildWorkerView } from "./state.ts";
import type { DelegateError, Transport } from "./transport/types.ts";

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function asDelegateError(err: unknown): DelegateError | null {
	if (err instanceof Error && typeof (err as DelegateError).code === "string") {
		return err as DelegateError;
	}
	return null;
}

async function logTo(dir: string, line: string): Promise<void> {
	try {
		await appendFile(`${dir}/teardown.log`, `[${new Date().toISOString()}] ${line}\n`);
	} catch {
		// best-effort audit log — never block teardown on logging failure
	}
}

export function registerCommands(pi: ExtensionAPI, transport: Transport) {
	pi.registerCommand("delegate-fleet", {
		description: "Mission-control overlay: live worker fleet status, reports, mailbox, budget burn (read-only)",
		async handler(_args, ctx) {
			await openFleetOverlay(ctx, { transport });
		},
	});

	pi.registerCommand("delegate-teardown", {
		description: "Confirm + sequentially tear down all delegate workers (pre-logged, never automatic)",
		async handler(_args, ctx) {
			const views = await buildWorkerView(transport);
			if (views.length === 0) {
				ctx.ui.notify("No delegate workers to tear down.", "info");
				// Nothing left to observe — also clear the ambient fleet UI (restore
				// footer) so no stale chip/widget survives an empty fleet.
				disposeFleetUI();
				return;
			}

			const list = views
				.map((v) => `${v.name} (${v.kind}${v.branch ? `, branch ${v.branch}` : ""})`)
				.join(", ");
			const confirmed = await ctx.ui.confirm(
				"Tear down delegate workers?",
				`${views.length} worker(s): ${list}`,
			);
			if (!confirmed) {
				ctx.ui.notify("Teardown cancelled — workers left running.", "info");
				return;
			}

			const outcomes: string[] = [];
			for (const v of views) {
				// Pre-log the planned mutating op BEFORE executing it (audit trail).
				await logTo(
					v.dir,
					`plan: teardown worker=${v.name} kind=${v.kind} workspace=${v.placement.workspaceId} pane=${v.placement.paneId}`,
				);
				try {
					await transport.teardown({ name: v.name, placement: v.placement, force: true });
					await logTo(v.dir, `done: teardown worker=${v.name} ok`);
					outcomes.push(`✓ ${v.name} (${v.kind}) torn down`);
				} catch (err) {
					await logTo(v.dir, `error: teardown worker=${v.name} failed: ${errText(err)}`);
					const de = asDelegateError(err);
					const advice = de?.guidance
						? ` — ${de.guidance}`
						// No structured guidance: fall back to the generic recovery recipe.
						: " — reconcile via `herdr workspace list`; for a not_linked_worktree answer, recover with `herdr workspace close <ID>`.";
					outcomes.push(`✗ ${v.name}: ${errText(err)}${advice}`);
				}
			}

			// Teardown emptied the fleet: clear the ambient widget + restore the
			// default footer via the module-level mount registry in fleet-ui.ts
			// (DESIGN.md §19.4 — the mount registry is documented in report-impl-ui.json).
			disposeFleetUI();
			ctx.ui.notify(`Teardown finished:\n${outcomes.join("\n")}`, "info");
		},
	});
}
