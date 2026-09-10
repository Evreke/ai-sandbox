/**
 * fleet-UX stage 2 — shared prod-prep-shaped fixture for the tree/fold
 * checks (test/fleet-tree-check.ts) and the one-off golden generator.
 *
 * Mirror of /tmp/exchange/prod-prep (CONTEXT.md): one task dir, 4 workers
 * ALL foreign to this session — sec-impl/ux-impl working worktrees (ctx
 * 41%/63%), sec-audit/ux-research idle tabs with landed reports. Plain and
 * marker themes let goldens be readable AND ANSI-checked.
 */

import type { FleetRow } from "../src/fleet.ts";

export const DIR = "/tmp/exchange/prod-prep";
export const FOREIGN = "/home/u/.pi/agent/sessions/--home-u-promobile--/s-orch.jsonl";
export const MINE = "/home/u/.pi/agent/sessions/--home-u-aisandbox--/s-me.jsonl";

/** Identity theme: fg returns text unchanged → goldens are readable ASCII. */
export const PLAIN_THEME = { fg: (_color: string, text: string) => text };

/** Marker theme (same shape as render-ui-check): [color]text[/]. */
export function markerTheme() {
	return {
		fg(color: string, text: string) {
			return `[${color}]${text}[/]`;
		},
	};
}

type Over = Partial<FleetRow>;
type ViewOver = Record<string, unknown>;

/** Fixed clock for the `s` stale-flag checks/goldens (v1.12.1, §22). */
export const NOW_MS = Date.parse("2026-09-07T12:00:00.000Z");

export function frow(name: string, over: Over = {}, viewOver: ViewOver = {}): FleetRow {
	return {
		view: {
			name,
			dir: DIR,
			status: "working",
			placement: {
				kind: "worktree",
				branch: `delegate/${name}`,
				checkoutPath: `/wt/${name}`,
				workspaceId: "ws-1",
				paneId: "pane-1",
			},
			kind: "worktree",
			branch: `delegate/${name}`,
			reportPath: `${DIR}/report-${name}.json`,
			reportExists: false,
			startedAt: "2026-09-07T00:00:00Z",
			elapsedMs: 60_000,
			...viewOver,
		} as FleetRow["view"],
		budget: 250_000,
		input: 31_200,
		output: 18_700,
		percent: 41,
		mail: "--",
		isProbe: false,
		ownership: "foreign",
		orchestratorSessionPath: FOREIGN,
		...over,
	} as FleetRow;
}

/** The prod-prep-shaped fixture: 4 foreign workers, 1 group. */
export function fixture(): FleetRow[] {
	return [
		frow("sec-impl"),
		frow("ux-impl", { input: 52_800, output: 34_900, percent: 63 }),
		frow(
			"sec-audit",
			{ input: 5_400, output: 3_900, percent: 17, budget: 524_000 },
			{
				status: "idle",
				reportExists: true,
				kind: "tab",
				branch: undefined as never,
				placement: { kind: "tab", checkoutPath: DIR, workspaceId: "ws-2", paneId: "pane-2" },
			},
		),
		frow(
			"ux-research",
			{ input: 8_100, output: 6_200, percent: 23, budget: 524_000 },
			{
				status: "idle",
				reportExists: true,
				kind: "tab",
				branch: undefined as never,
				placement: { kind: "tab", checkoutPath: DIR, workspaceId: "ws-2", paneId: "pane-2" },
			},
		),
	];
}

/** Two mine workers (one blocked with a mailbox question). */
export function mineFixture(): FleetRow[] {
	return [
		frow("impl-a", { ownership: "mine", orchestratorSessionPath: MINE }),
		frow(
			"impl-b",
			{ ownership: "mine", orchestratorSessionPath: MINE, percent: 83, mail: "Q?" },
			{ status: "blocked" },
		),
	];
}

/** N foreign single-worker groups in distinct task dirs (mega-line guard). */
export function megaFixture(groups: number): FleetRow[] {
	const out: FleetRow[] = [];
	for (let i = 1; i <= groups; i++) {
		out.push(frow(`w${i}`, {}, { dir: `/tmp/exchange/task-${i}` }));
	}
	return out;
}

/** The prod-prep fixture with EVERY member collected ≥30 min ago → the
 *  folded line gains the `s` flag (stale-idle group, v1.12.1). */
export function staleFixture(): FleetRow[] {
	return fixture().map((r, i) => ({
		...r,
		collectedAt: new Date(NOW_MS - (31 + i) * 60_000).toISOString(),
	}));
}
