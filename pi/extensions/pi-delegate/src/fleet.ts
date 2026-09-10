/**
 * pi-delegate — fleet UI module: everything the extension renders about the
 * worker fleet (DESIGN.md §15 overlay, §19.4 ambient widget), plus the two
 * things the UI layers share: worker ownership classification and width-safe
 * text primitives.
 * <p>
 * MODULE_CONTRACT: fleet presentation layer — ownership classification,
 * wide-char-safe text helpers, ambient live-rows widget + tool-result
 * transcript rendering, and the /delegate-fleet full-screen overlay
 * (grouping / tree / fold / legend). W1 refactor: verbatim concatenation of
 * the old src/ownership.ts, src/ui/text.ts, src/ui/fleet-ui.ts and
 * src/ui/fleet.ts. W6: the worker-view aggregation (WorkerView +
 * buildWorkerView) moved in verbatim from observe.ts (ex src/state.ts) —
 * view-building (manifests × statuses → WorkerView) is view code and now
 * lives with the other view code; this broke the former runtime-benign
 * fleet<->observe import cycle (fleet imported buildWorkerView while
 * observe imported these render helpers). The graph is a DAG again:
 * observe → fleet is the only edge between the two.
 * Dependencies: exchange.ts (scanAllManifests), usage.ts (session JSONL
 * usage), transport.ts (CONTEXT_WARN_PCT + Transport type),
 * @earendil-works/pi-coding-agent TUI. The former watch.ts dependency
 * (WATCH_DEFAULT_STALE_AFTER_MS) stays inlined as a local literal at
 * FLEET_STALE_AFTER_MS: importing it from observe.ts would RE-CREATE the
 * fleet<->observe cycle (observe imports this module's render helpers)
 * with its module-eval TDZ ReferenceError hazard whenever observe is
 * evaluated first; duplication is the sanctioned tool (design law 2). The
 * literal is kept in sync with WATCH_DEFAULT_STALE_AFTER_MS in
 * src/observe.ts (watch section).
 * Exported surface: WorkerView, buildWorkerView | classifyOwnership,
 * OWNERSHIP_GLYPH, Ownership,
 * SelfIdentity, OwnershipPlacement | stripAnsi, visibleWidth, trunc,
 * clampLines, fmtK | FleetWidgetRow (widget row; historical name FleetRow is
 * kept alive by the ui/fleet-ui.ts facade, removed in W5 — importers use
 * FleetWidgetRow), FleetUIDeps, FleetFoldLine,
 * mountFleetUI, disposeFleetUI, renderLiveRows, foldLiveByOwnership,
 * notifyFleetIdle, renderDelegateLines | FleetRow (overlay row), FleetDeps,
 * FleetLayoutRow, FleetLayout, FLEET_FLOORS, fleetUsageOf, layoutFleetRows,
 * fitRow, GroupStatsRow, GroupClass, WorkerGroup, MEGA_GROUP_LIMIT,
 * FLEET_STALE_AFTER_MS, groupWorkerViews, rankGroups, groupHeaderText,
 * isFleetStale, fleetAgeText, groupFoldedText, megaFoldedText,
 * fleetFoldToggle, fleetFoldUnfolded, FleetRenderInput, packLegend,
 * renderFleet, openFleetOverlay.
 * Critical invariants (owned here, per report-ref-map.json hiddenInvariants):
 *   - line-width-clamping: EVERY TUI-rendered line must pass through
 *     clampLines / fitRow / trunc — an over-wide line crashes the whole TUI
 *     with uncaughtException (v1.8b field crash). All render fns here
 *     return clamped lines.
 *   - display fails CLOSED on ownership (deliberate asymmetry vs the
 *     watcher, which fails open): a marker is a claim, and an unknown
 *     worker must never render as "mine" (●) in either direction of
 *     missing data (classifyOwnership + ownershipGlyph).
 *   - fleet UI is ADVISORY: fs/transport read failures keep the last
 *     snapshot and never alter a spawn/collect/wake outcome.
 *   - the overlay is strictly read-only (fs reads + transport.listStatuses
 *     only; timers cleared on close AND dispose). The ambient widget's 2 s
 *     interval is NOT cleared when the live set goes empty (only on
 *     dispose) so the widget can re-mount on the next spawn.
 *   - FLEET_STALE_AFTER_MS shares the watcher's worker-stale default
 *     (§22): one stale threshold across watcher and fleet UI.
 * Error modes: none thrown to callers — all failures degrade (the E_*
 * taxonomy lives in transport.ts).
 */

import { readFile, stat } from "node:fs/promises";
import type { ExtensionCommandContext, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { scanAllManifests } from "./exchange.ts";
import { contextPct, parseSessionUsage, resolveContextWindow } from "./usage.ts";
import {
	CONTEXT_WARN_PCT,
	type AgentStatusName,
	type Placement,
	type Transport,
} from "./transport.ts";

// ===========================================================================
// SECTION 1/4 — worker ownership classification
// (verbatim move of the old src/ownership.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — worker ownership classification (fleet-UX wave 2, stage 1).
 *
 * Mirror of the watcher's ownership rule (observe.ts isSelf /
 * detectWorkerEvents, DESIGN.md §21.1 F1): a worker is MINE iff the manifest's
 * `orchestratorSessionPath` equals THIS session's JSONL path. Legacy manifests
 * carry no such field → ownership UNKNOWN.
 *
 * DELIBERATE ASYMMETRY vs the watcher: the watcher fails OPEN (a legacy
 * manifest or a degraded self-id must never swallow a real wake-up), while
 * DISPLAY fails CLOSED — a marker is a claim, and an unknown worker must
 * never render as "mine" (●) in either direction of missing data:
 *   - manifest edge: no `orchestratorSessionPath` → UNKNOWN (legacy).
 *   - self edge: no session file → exact comparison impossible → UNKNOWN,
 *     with ONE fallback mirroring observe.ts isSelf: a worktree worker whose
 *     unique `placement.checkoutPath` equals this session's cwd is MINE
 *     (checkout paths are per-worker; tab workers share the repo cwd and are
 *     NEVER matched by it — they stay UNKNOWN).
 *
 * Pure function: no fs, no transport, no theme — unit-tested in
 * test/ownership-check.ts.
 */

/** Ownership class of one worker, as seen from THIS session. */
export type Ownership = "mine" | "foreign" | "unknown";

/** This session's identity (same shape as observe.ts SelfIdentity). */
export interface SelfIdentity {
	/** This session's JSONL path (ctx.sessionManager.getSessionFile()). */
	sessionFile?: string;
	/** This session's cwd (ctx.cwd). */
	cwd?: string;
}

/** The placement slice classification needs (structurally satisfied by
 *  transport.ts Placement). */
export interface OwnershipPlacement {
	kind?: string;
	checkoutPath?: string;
}

/**
 * Classify one worker's ownership from the manifest's recorded owner session
 * path, this session's identity, and the worker's placement.
 *
 * - `orchestratorSessionPath` non-empty and === self.sessionFile → "mine".
 * - non-empty and different (self.sessionFile known) → "foreign".
 * - absent/empty (legacy manifest) → UNKNOWN, except the degraded-self-id
 *   fallback: self.sessionFile unknown + worktree + checkoutPath === cwd →
 *   "mine". Tab workers are never matched by cwd → stay "unknown".
 * - non-empty but self.sessionFile unknown → UNKNOWN (fail-closed: cannot
 *   prove the worker is not ours, so never claim it either).
 */
export function classifyOwnership(
	orchestratorSessionPath: string | undefined,
	self: SelfIdentity,
	placement: OwnershipPlacement,
): Ownership {
	const field =
		typeof orchestratorSessionPath === "string" && orchestratorSessionPath.length > 0
			? orchestratorSessionPath
			: undefined;
	if (field !== undefined) {
		if (self.sessionFile === undefined) return "unknown"; // fail-closed
		return field === self.sessionFile ? "mine" : "foreign";
	}
	// Legacy manifest: no owner field recorded → fail-closed UNKNOWN, with the
	// observe.ts isSelf worktree fallback for a degraded self-id only.
	if (self.sessionFile !== undefined) return "unknown";
	if (
		placement?.kind === "worktree" &&
		self.cwd !== undefined &&
		typeof placement.checkoutPath === "string" &&
		placement.checkoutPath === self.cwd
	) {
		return "mine";
	}
	return "unknown"; // tabs never match by cwd
}

/** Overlay/widget glyph for an ownership class — all 1 terminal column
 *  (U+25CF/U+25CB/U+25CC are outside text.ts charWidth's wide ranges). */
export const OWNERSHIP_GLYPH: Record<Ownership, string> = {
	mine: "●",
	foreign: "○",
	unknown: "◌",
};

// ===========================================================================
// SECTION 2/4 — shared text helpers for UI rendering
// (verbatim move of the old src/ui/text.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — shared text helpers for UI rendering (quality fix A7).
 *
 * ONE fmtK, ONE trunc (visibleWidth-aware, wide-char safe), ONE stripAnsi.
 * Previously these were triplicated with DIVERGENT semantics across
 * fleet.ts / observe.ts (status tool) (same names, different
 * output — e.g. fmtK(836) was "836" in fleet.ts but "1k" in fleet-ui.ts).
 * All UI modules import from here; local duplicates were deleted.
 */

/** Strip ANSI escape sequences (CSI … final-byte) from a string. */
export function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Display width of a single code point: 2 for CJK/wide ranges, else 1. */
function charWidth(ch: string): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0xa4cf) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe30 && cp <= 0xfe4f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		cp >= 0x20000
	) {
		return 2;
	}
	return 1;
}

/** Visible width of a string (ANSI-free; wide chars count as 2 columns). */
export function visibleWidth(s: string): number {
	let w = 0;
	for (const ch of stripAnsi(s)) w += charWidth(ch);
	return w;
}

/** Width-aware truncate with ellipsis (wide-char safe, ANSI-tolerant):
 *  the result's visible width never exceeds `w`. */
export function trunc(s: string, w: number): string {
	if (w <= 0) return "";
	if (visibleWidth(s) <= w) return s;
	let out = "";
	for (const ch of s) {
		if (visibleWidth(out) + charWidth(ch) > w - 1) break;
		out += ch;
	}
	return `${out}…`;
}

/** Clamp every rendered line to the width pi-tui passes to
 *  component.render(width). Over-wide transcript lines crash the whole TUI
 *  with uncaughtException "Rendered line N exceeds terminal width" — every
 *  custom render closure MUST route its lines through this (field crash
 *  2026-09-05: delegate heartbeat headline 150 > 139 killed pi). No-op when
 *  no width is known (headless/session replay). */
export function clampLines(lines: string[], width?: number): string[] {
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return lines;
	const w = Math.floor(width);
	return lines.map((l) => (visibleWidth(l) <= w ? l : trunc(l, w)));
}

/** Compact k-denominated token count: <1000 → "n" (836 → "836"); else one
 *  decimal below 100k, integer k from 100k up (9592 → "9.6k", 18517 → "18.5k",
 *  150000 → "150k"). Non-finite/negative → "0". */
export function fmtK(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

// ===========================================================================
// SECTION 3/4 — ambient fleet UI (widget + tool-result rendering)
// (verbatim move of the old src/ui/fleet-ui.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — ambient fleet UI (DESIGN.md §19.4).
 *
 * OWNERSHIP: contracts authored by the tech lead; implementation owned by
 * worker B6 (impl-ui). All functions MUST be inert when the context has no UI.
 *
 * Primitives (verified in pi docs/examples, Patterns 4/5/6):
 *   ctx.ui.setWidget(id, renderer, {placement})   — live rows above editor
 *   (setFooter REJECTED — it REPLACES pi's native footer (context %, model,
 *    cost, cwd): unacceptable. The placed-count chip was REMOVED entirely
 *    (confusing: global cross-session count, pessimistic burn) — v1.8.
 *    The live-rows widget is the only ambient surface.)
 *   ctx.ui.notify(msg, level)                     — nudges
 *   registerTool renderCall/renderResult          — themed transcript rendering
 *
 * Design choice (documented in report-impl-ui.json): the refresh interval is
 * NOT cleared when the live set goes empty (only on dispose) — DESIGN.md §19.4
 * says "timer cleared on empty", but that would freeze the widget forever after
 * the first idle window (nothing would ever re-mount it when a new worker
 * spawns). Keeping the 2 s tick costs one cheap getRows() poll and lets the
 * widget reappear on the next spawn; the WIDGET is cleared on empty, the
 * FOOTER chip persists per the B6 contract.
 */


/** Data the UI needs per worker — supplied by the caller (observe.ts + usage.ts). */
export interface FleetWidgetRow {
	name: string;
	status: string;
	kind: string;
	branch?: string;
	reportExists?: boolean;
	isProbe?: boolean;
	inputTokens: number;
	outputTokens: number;
	budgetPct: number | null;
	lastPing?: { phase: string; pct?: number };
	/** Ownership class vs THIS session (v1.12.0). Absent (legacy callers)
	 *  degrades to the fold's legacy class — never rendered as mine. */
	ownership?: Ownership;
	/** Exchange task slug (manifest dir basename) — fold-line task list. */
	task?: string;
}

export interface FleetUIDeps {
	getRows(): Promise<FleetWidgetRow[]>;
}

// ---------------------------------------------------------------------------
// Module-level mount registry: /delegate-teardown restores the footer via
// disposeFleetUI() without needing the dispose handle that mountFleetUI
// returned (possibly in a different closure). Double-mount replaces.
// ---------------------------------------------------------------------------

let activeDispose: (() => void) | null = null;

/** Dispose the currently mounted fleet UI (widget cleared, default footer
 *  restored). Safe to call when nothing is mounted. */
export function disposeFleetUI(): void {
	const d = activeDispose;
	activeDispose = null;
	d?.();
}

// ---------------------------------------------------------------------------
// Shared formatting helpers live in this module (SECTION 2) (ONE fmtK/trunc/stripAnsi —
// quality fix A7); this module imports from there.
// ---------------------------------------------------------------------------

/** Minimal structural slice of Theme — renderDelegateLines must stay pure and
 *  unit-testable without importing the real Theme class. */
interface FgTheme {
	fg(color: ThemeColor, text: string): string;
}

const LIVE_STATUSES = new Set(["working", "blocked"]);
/** Budget burn at/above this percentage renders in the error color. */
const BURN_ERROR_PCT = 80;

function isLive(row: FleetWidgetRow): boolean {
	return LIVE_STATUSES.has(row.status);
}

// ---------------------------------------------------------------------------
// mountFleetUI
// ---------------------------------------------------------------------------

/**
 * Mount the live fleet widget (only ambient surface). Idempotent: calling
 * twice replaces the previous mount. Starts a 2 s refresh interval that
 * renders live workers (working/blocked) as rows above the editor; the
 * widget clears when no live workers remain. Returns a dispose function
 * (clears timers + widget) — used by /delegate-teardown.
 */
export function mountFleetUI(ctx: ExtensionContext, deps: FleetUIDeps): () => void {
	// Headless guard: MUST work (no-op) when there is no UI.
	if (!ctx.hasUI || !ctx.ui) return () => {};

	// Idempotent double-mount: replace the previous mount.
	activeDispose?.();
	activeDispose = null;

	const WIDGET_KEY = "delegate-fleet";
	const REFRESH_MS = 2000;

	let rows: FleetWidgetRow[] = [];
	let widgetShown = false;
	let disposed = false;
	let tuiRef:
		| { requestRender(force?: boolean): void; terminal?: { columns?: number } }
		| undefined;

	const showWidget = (): void => {
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				tuiRef = tui;
				return {
					// v1.8b: clamp to the width pi-tui passes — over-wide widget lines
					// crash the TUI (same failure shape as transcript lines).
					render: (width?: number) =>
						clampLines(
							renderLiveRows(rows, theme, (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns ?? width),
							width,
						),
					invalidate: () => {},
				};
			},
			{ placement: "aboveEditor" },
		);
		widgetShown = true;
	};

	const refresh = async (): Promise<void> => {
		if (disposed) return;
		try {
			rows = await deps.getRows();
		} catch {
			// keep last snapshot on read failure — the UI is advisory
			return;
		}
		if (disposed) return;
		const live = rows.filter(isLive);
		if (live.length === 0 && widgetShown) {
			// EMPTY live set → live-rows widget cleared; chip widget tracks placed count.
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetShown = false;
		} else if (live.length > 0 && !widgetShown) {
			showWidget();
		}
		tuiRef?.requestRender();
	};

	void refresh();
	const timer = setInterval(() => {
		void refresh();
	}, REFRESH_MS);

	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		clearInterval(timer);
		if (ctx.hasUI && ctx.ui) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			// Defensive: restore the native footer if any older build replaced it.
			ctx.ui.setFooter(undefined);
		}
		if (activeDispose === dispose) activeDispose = null;
	};
	activeDispose = dispose;
	return dispose;
}

/** Themed live rows: `▲ name status ↑in ↓out P% [ping: phase]` — clamped to width.
 *  Ownership policy (v1.12.0, attention-gated fold): MY live workers render
 *  exactly as before (byte-identical lines); foreign/legacy live workers are
 *  FOLDED into at most one summary line PER CLASS (≤2 total), and a class
 *  line appears IFF at least one worker in that class is `blocked` OR at
 *  `ctx% ≥ CONTEXT_WARN_PCT` — a quiet foreign fleet renders NOTHING above
 *  the editor. Pure and unit-testable (test/ownership-check.ts). */
export function renderLiveRows(rows: FleetWidgetRow[], theme: Theme, width?: number): string[] {
	const live = rows.filter(isLive);
	if (live.length === 0) return [];
	const mine = live.filter((r) => r.ownership === "mine");
	const maxW = width && width > 20 ? width - 1 : undefined;
	const lines = mine.map((r) => {
		const pct = typeof r.budgetPct === "number" ? `${r.budgetPct}%` : "?";
		const ping = r.lastPing ? ` [ping: ${r.lastPing.phase}]` : "";
		const line = `▲ ${r.name} ${r.status} ↑${fmtK(r.inputTokens)} ↓${fmtK(r.outputTokens)} ${pct} of budget${ping}`;
		// Budgets ≥80% burn override the status color with error.
		const color: ThemeColor =
			typeof r.budgetPct === "number" && r.budgetPct >= BURN_ERROR_PCT
				? "error"
				: r.status === "blocked"
					? "warning"
					: "accent";
		return theme.fg(color, maxW ? trunc(line, maxW) : line);
	});
	for (const fold of foldLiveByOwnership(live)) lines.push(theme.fg(fold.color, fold.text));
	return lines;
}

/** One folded summary line: pre-colored text + its theme color. */
export interface FleetFoldLine {
	text: string;
	color: ThemeColor;
}

/** Fold-line shape per non-mine class: `○ N foreign live (task1, task2)`
 *  (muted) / `◌ N legacy live (…)` (dim). Task list = unique task slugs of
 *  that class's LIVE workers. */
const FOLD_CLASSES: Array<{
	cls: Exclude<Ownership, "mine">;
	glyph: string;
	label: string;
	color: ThemeColor;
}> = [
	{ cls: "foreign", glyph: "○", label: "foreign", color: "muted" },
	{ cls: "unknown", glyph: "◌", label: "legacy", color: "dim" },
];

/**
 * Attention-gated widget fold (pure): the foreign/legacy summary lines for a
 * LIVE set, at most one per class (≤2 lines total). A class line appears IFF
 * at least one of its live workers is `blocked` or sits at/above
 * CONTEXT_WARN_PCT context burn — no signals → no line (a quiet foreign
 * fleet costs the widget NOTHING). Uses only row data: no fs reads, no
 * mailbox joins. Fold lines are short by construction and the widget render
 * routes every line through clampLines (v1.8b TUI-crash guard).
 */
export function foldLiveByOwnership(live: FleetWidgetRow[]): FleetFoldLine[] {
	const lines: FleetFoldLine[] = [];
	for (const { cls, glyph, label, color } of FOLD_CLASSES) {
		const rows = live.filter((r) => (r.ownership ?? "unknown") === cls);
		if (rows.length === 0) continue;
		const attention = rows.some(
			(r) =>
				r.status === "blocked" ||
				(typeof r.budgetPct === "number" && r.budgetPct >= CONTEXT_WARN_PCT),
		);
		if (!attention) continue;
		const tasks = [...new Set(rows.map((r) => r.task).filter((t): t is string => typeof t === "string" && t.length > 0))];
		const list = tasks.length > 0 ? ` (${tasks.join(", ")})` : "";
		lines.push({ text: `${glyph} ${rows.length} ${label} live${list}`, color });
	}
	return lines;
}

// ---------------------------------------------------------------------------
// notifyFleetIdle
// ---------------------------------------------------------------------------

/** Fire the teardown nudge: ctx.ui.notify when the fleet just went idle. */
export function notifyFleetIdle(ctx: ExtensionContext, placedCount: number): void {
	if (!ctx.hasUI || !ctx.ui) return; // headless → no-op
	if (placedCount <= 0) return;
	ctx.ui.notify(`fleet idle — /delegate-teardown to clean up ${placedCount} tabs`, "info");
}

// ---------------------------------------------------------------------------
// renderDelegateLines — pure, unit-testable
// ---------------------------------------------------------------------------

/** herdr internals that must never appear in visible lines (details only). */
const HERD_ID_RE = /\b(?:terminal_id|pane_id|workspace_id)=[^\s,;)]+/gi;
const HERD_ID_PLACEHOLDER = "<herdr ids in details>";

/** Recoverable codes render as warning; the rest as error. */
const WARNING_CODES = new Set(["E_TIMEOUT", "E_PROMPT_STALLED"]);

/** Word-wrap at ~100 columns on spaces (plain-text details, ANSI-free input). */
function wrapLine(text: string, width = 100): string[] {
	const out: string[] = [];
	let current = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= width) {
			current += ` ${word}`;
		} else {
			out.push(current);
			current = word;
		}
	}
	if (current.length > 0) out.push(current);
	return out;
}

/**
 * Render one delegate-family tool result as themed lines for the transcript.
 * Rules (DESIGN.md §19.4): status-colored badge; E_* code as error/warning;
 * ONE-line verdict headline; herdr internals (terminal_id/pane_id/… patterns)
 * NEVER in the headline — caller still puts them in details. Returns lines.
 */
export function renderDelegateLines(
	toolName: string,
	resultText: string,
	theme: unknown,
): string[] {
	const th = theme as FgTheme;
	const fg = (color: ThemeColor, text: string): string =>
		th && typeof th.fg === "function" ? th.fg(color, text) : text;

	const allLines = (resultText ?? "").split("\n");
	const rawHeadline = allLines[0] ?? "";
	const detailText = allLines.slice(1).join(" ").trim();

	// Badge selection: AWAITING_ANSWER → warning; E_* → error/warning; else OK.
	let badge: string;
	if (/\bAWAITING_ANSWER\b/.test(rawHeadline)) {
		badge = fg("warning", "[AWAITING_ANSWER]");
	} else {
		const codeMatch = rawHeadline.match(/^E_[A-Z_]+/);
		if (codeMatch) {
			const code = codeMatch[0];
			badge = fg(WARNING_CODES.has(code) ? "warning" : "error", `[${code}]`);
		} else {
			badge = fg("success", "[OK]");
		}
	}

	// Headline: one line, herdr internals stripped (details carry them).
	const headline = rawHeadline.replace(HERD_ID_RE, HERD_ID_PLACEHOLDER);
	const lines = [`${fg("muted", `[${toolName}]`)} ${badge} ${headline}`];

	// Up to 3 wrapped detail lines, herdr internals stripped.
	if (detailText.length > 0) {
		const stripped = detailText.replace(HERD_ID_RE, HERD_ID_PLACEHOLDER);
		const wrapped = wrapLine(stripped).slice(0, 3);
		for (const w of wrapped) lines.push(fg("dim", `  ${w}`));
	}
	return lines;
}

// ===========================================================================
// SECTION 4/4 — /delegate-fleet mission-control overlay
// (verbatim move of the old src/ui/fleet.ts; its review-verified header comment is preserved)
// ===========================================================================

/**
 * pi-delegate — `/delegate-fleet` mission-control overlay (DESIGN.md §15).
 *
 * OWNERSHIP: worker F2 (impl-fleet); stage 2 (tree + fold) on top.
 *
 * Full-screen read-only overlay: one row per known worker, refreshed every
 * 2s. Strictly read-only — the only side effects are fs READS (manifests,
 * report/q/a existence checks, session JSONL usage parsing) and the
 * read-only transport.listStatuses() inside buildWorkerView(). No mutating
 * herdr calls, no mailbox writes, no timers left behind (interval is
 * cleared on close AND on dispose).
 *
 * STAGE 2 (fleet-UX wave 2): rows group by `manifest.dir ::
 * orchestratorSessionPath` (report-ux-tree.json). MINE rows render FLAT
 * exactly as stage 1 (zero single-session regression). FOREIGN/UNKNOWN
 * groups render an expanded dim header `▼ slug · live/total live · owner ·
 * ctx↑max%` with inline tree glyphs in the name column, and FOLD by default
 * to a self-describing line `~ <class> <slug> · N workers · counts… ·
 * idle <age>` (fleet-UX wave 4 retired the letter-flag alphabet `xN -- L B
 * ! Q v s` — counts are words, the stale `s` condition became an age tail
 * with an ownership-scoped remedy); Tab (0x09) toggles
 * (§4 exact: module-level session-scoped boolean, folded first-open
 * default, no-op when nothing foldable). Per-group sort replaces the
 * global status sort, with fully-stale groups demoted (wave 4); the height
 * window is group-atomic and stale-aware (fresh blocks trim first). All of
 * it is pure (groupWorkerViews/rankGroups/groupHeaderText/groupFoldedText/
 * megaFoldedText/renderFleet) and unit-tested headless in
 * test/fleet-tree-check.ts. The widget (fleet-ui.ts) is untouched.
 */

/** How often the overlay re-renders (poll buildWorkerView + fs state). */
const REFRESH_MS = 2000;

/** Minimal structural slice of the TUI we need — avoids importing pi-tui. */
interface RenderPoke {
	requestRender(force?: boolean): void;
	terminal?: { columns?: number; rows?: number };
}

export interface FleetDeps {
	/** Injected transport (same seam the rest of the extension uses). */
	transport: Transport;
}

// ---------------------------------------------------------------------------
// Local key helper (pi-tui's matchesKey is not reachable from this repo's
// node_modules layout); width/trunc/fmtK live in this module (SECTION 2).
// ---------------------------------------------------------------------------

function isEscape(data: string): boolean {
	return data === "\x1b"; // bare ESC byte (escape sequences start with ESC[)
}

// ---------------------------------------------------------------------------
// Manifest extras: sessionPath + per-call budgetTokens live in the on-disk
// manifest but are not projected onto WorkerView — read them tolerantly.
// ---------------------------------------------------------------------------

interface ManifestExtras {
	sessionPath?: string;
	budgetTokens?: number;
	briefPath?: string;
	model?: string;
	/** Owner session JSONL path (v1.11.1+) — absent on legacy manifests. */
	orchestratorSessionPath?: string;
	/** ISO 8601 collect stamp (v1.12.1) — drives the folded group's stale
	 *  age tail (§22.3). */
	collectedAt?: string;
}

/**
 * Read the manifest extras the overlay needs beyond WorkerView.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - dir: exchange task dir containing manifest.json
 *   - name: worker name to find in manifest.workers
 * Output: ManifestExtras — only fields present AND of the expected type are
 *   projected; every field optional
 * Guarantees:
 *   - tolerant: missing/corrupt manifest, missing worker, wrong-typed field →
 *     {} or field omitted; NEVER throws
 *   - read-only
 * Raises: none
 */
async function readManifestExtras(dir: string, name: string): Promise<ManifestExtras> {
	try {
		// EXTERNAL_DEPENDENCY: exchange manifest on disk at <dir>/manifest.json
		// (dir is under /tmp/exchange/<task>/); shape documented in exchange.ts.
		const raw: unknown = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
		const workers = (raw as { workers?: unknown })?.workers;
		if (!Array.isArray(workers)) return {};
		const w = workers.find(
			(x): x is { name?: unknown; sessionPath?: unknown; budgetTokens?: unknown; briefPath?: unknown; model?: unknown; orchestratorSessionPath?: unknown; collectedAt?: unknown } =>
				typeof x === "object" && x !== null && (x as { name?: unknown }).name === name,
		);
		if (!w) return {};
		const extras: ManifestExtras = {};
		if (typeof w.sessionPath === "string" && w.sessionPath.length > 0) {
			extras.sessionPath = w.sessionPath;
		}
		if (typeof w.orchestratorSessionPath === "string" && w.orchestratorSessionPath.length > 0) {
			extras.orchestratorSessionPath = w.orchestratorSessionPath;
		}
		if (typeof w.budgetTokens === "number" && Number.isFinite(w.budgetTokens) && w.budgetTokens > 0) {
			extras.budgetTokens = w.budgetTokens;
		}
		if (typeof w.briefPath === "string") {
			extras.briefPath = w.briefPath;
		}
		if (typeof w.model === "string" && w.model.length > 0) {
			extras.model = w.model;
		}
		if (typeof w.collectedAt === "string" && w.collectedAt.length > 0) {
			extras.collectedAt = w.collectedAt;
		}
		return extras;
	} catch {
		return {}; // missing/corrupt manifest → zero-usage row, never throw
	}
}

/** File mtime in ms, or 0 when missing/unreadable. Read-only. */
async function mtimeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

/** Mailbox state: "Q?" worker question awaiting answer, "A→" answer posted. */
async function mailState(dir: string, name: string): Promise<"Q?" | "A→" | "--"> {
	// EXTERNAL_DEPENDENCY: mailbox files on disk — q-<name>.json / a-<name>.json
	// in the exchange dir (mtime comparison decides which side is newer).
	const q = await mtimeOf(`${dir}/q-${name}.json`);
	if (q === 0) return "--";
	const a = await mtimeOf(`${dir}/a-${name}.json`);
	return a > q ? "A→" : "Q?";
}

// ---------------------------------------------------------------------------
// Row model
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<WorkerView["status"], number> = {
	blocked: 0,
	working: 1,
	idle: 2,
	done: 3,
	unknown: 4,
};

/**
 * Sorts worker views for fleet display: blocked first, then working, idle,
 * done, unknown (STATUS_ORDER); ties broken alphabetically by name.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - views: worker views in any order (as produced by buildWorkerView)
 * Output: a NEW array sorted by status severity (blocked < working < idle <
 *   done < unknown per STATUS_ORDER), then by name via localeCompare
 * Guarantees:
 *   - pure / non-mutating: the input array is copied (`[...views]`), the
 *     caller's array is never reordered
 *   - deterministic: same input → same output order (localeCompare is a
 *     stable tiebreak; Array.prototype.sort is stable, equal pairs keep
 *     input order)
 *   - never throws for any WorkerView (every status has a STATUS_ORDER entry)
 * Raises: none
 */
function sortViews(views: WorkerView[]): WorkerView[] {
	return [...views].sort(
		(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
	);
}

export interface FleetRow {
	view: WorkerView;
	budget: number;
	input: number;
	output: number;
	percent: number;
	mail: "Q?" | "A→" | "--";
	/** Probe worker (spawned with mode:"probe", manifest briefPath ""). */
	isProbe: boolean;
	/** Ownership class vs THIS session (fail-closed: unknown never mine). */
	ownership: Ownership;
	/** Owner session JSONL (v1.11.1+); undefined = legacy manifest.
	 *  Grouping key half (stage 2) — the per-row class stays authoritative. */
	orchestratorSessionPath?: string;
	/** ISO 8601 collect stamp (v1.12.1) — stale age tail input; undefined =
	 *  never collected (fresh worker). */
	collectedAt?: string;
}

/**
 * Builds one display row: merges the live worker view with manifest extras,
 * mailbox state and session-usage gauges.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - view: WorkerView for the row (dir, name, status, elapsedMs, placement)
 *   - extras: manifest data (ManifestExtras — sessionPath, model, briefPath,
 *     orchestratorSessionPath, collectedAt)
 *   - mail: mailbox state for this worker ("Q?" question pending, "A→"
 *     answered, "--" none) — computed by mailState
 *   - self: this session's identity (for ownership classification)
 * Output: FleetRow — view + usage gauges (budget/input/output/percent),
 *   mail state, isProbe, ownership class, provenance fields
 * Guarantees:
 *   - usage gauges never throw: parseSessionUsage degrades to a zeroed entry
 *     on missing/unreadable session JSONL; contextPct null (unknown ctx) →
 *     percent 0
 *   - isProbe is true exactly when the manifest briefPath is "" (probes are
 *     spawned with mode:"probe", no report expected — probe honesty §19.4)
 *   - ownership is classifyOwnership's fail-closed verdict (unknown is never
 *     "mine")
 *   - read-only: only the session JSONL is read (synchronously, via
 *     parseSessionUsage); nothing is written
 * Raises: none (all failure paths degrade, see Guarantees)
 */
function buildRow(view: WorkerView, extras: ManifestExtras, mail: "Q?" | "A→" | "--", self: SelfIdentity): FleetRow {
	// EXTERNAL_DEPENDENCY (via usage.ts): the worker's session JSONL (manifest
	// `sessionPath`) is read synchronously for the usage gauges.
	const usage = parseSessionUsage(extras.sessionPath ?? "");
	const window = resolveContextWindow(extras.model);
	const percent = contextPct(usage, window) ?? 0;
	// Probe workers never produce a report (§19.4 probe honesty): manifest
	// briefPath is "" exactly for probes.
	const isProbe = extras.briefPath === "";
	const ownership = classifyOwnership(extras.orchestratorSessionPath, self, view.placement);
	return {
		view,
		budget: window,
		input: usage.input,
		output: usage.output,
		percent,
		mail,
		isProbe,
		ownership,
		orchestratorSessionPath: extras.orchestratorSessionPath,
		collectedAt: extras.collectedAt,
	};
}

/** Ownership glyph + theme color: ● mine (accent), ○ foreign (muted),
 *  ◌ legacy/unknown (dim) — display is fail-closed, unknown never mine. */
function ownershipGlyph(ownership: Ownership): { glyph: string; color: ThemeColor } {
	switch (ownership) {
		case "mine":
			return { glyph: OWNERSHIP_GLYPH.mine, color: "accent" };
		case "foreign":
			return { glyph: OWNERSHIP_GLYPH.foreign, color: "muted" };
		case "unknown":
			return { glyph: OWNERSHIP_GLYPH.unknown, color: "dim" };
	}
}

function statusColor(status: WorkerView["status"]): ThemeColor {
	switch (status) {
		case "blocked":
			return "error";
		case "working":
			return "accent";
		case "done":
			return "success";
		default:
			return "dim";
	}
}

// ---------------------------------------------------------------------------
// Pure layout fitting (extracted for unit testing — quality fix A7): no theme,
// no I/O. FleetOverlay.render is a thin themed skin over these results.
// ---------------------------------------------------------------------------

/** Theme-free input row: exactly what the fitting needs. */
export interface FleetLayoutRow {
	name: string;
	branch: string;
	input: number;
	output: number;
	percent: number;
	budget: number;
}

/** Fitted layout: final column widths + per-row cells, every cell already
 *  truncated and padded to its column width (ellipsis included). */
export interface FleetLayout {
	nameW: number;
	branchW: number;
	usageW: number;
	cells: Array<{ name: string; branch: string; usage: string }>;
}

/** Column floors — shrink loops never go below these. */
export const FLEET_FLOORS = { name: 8, branch: 6, usage: 12 } as const;

/** Usage column string: `↑52.8k ↓34.9k (999% of 150k)` (compact fmtK form). */
export function fleetUsageOf(r: Pick<FleetLayoutRow, "input" | "output" | "percent" | "budget">): string {
	return `↑${fmtK(r.input)} ↓${fmtK(r.output)} (${r.percent}% of ${fmtK(r.budget)})`;
}

function pad(s: string, len: number): string {
	return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
}

/**
 * Fit the fleet table (name status branch report mail usage) to `innerW`.
 * Shrink priority: branch → name → usage; floors {branch:6, name:8, usage:12}
 * keep columns readable. Cells are trunc'd then padded — a cell can never
 * push past its (fitted) column, so a row can never push past the border.
 */
export function layoutFleetRows(rows: FleetLayoutRow[], innerW: number): FleetLayout {
	const nameNat = Math.max(4, ...rows.map((r) => visibleWidth(r.name)));
	const branchNat = Math.max(6, ...rows.map((r) => visibleWidth(r.branch)));
	const usageNat = Math.max(12, ...rows.map((r) => visibleWidth(fleetUsageOf(r))));

	let nameW = Math.min(nameNat, 18);
	let branchW = Math.min(branchNat, 18);
	let usageW = Math.min(usageNat, 34);
	// total = glyph(1)+1(sp)+nameW+1+status(7)+1+branchW+1+report(1)+1+mail(2)
	//         +2(sp sp)+usageW — fixed cost 18, verified against the rendered
	// row `${glyph} ${name} ${status} ${branch} ${report} ${mail}  ${usage}`.
	// v1.12.0: the lead space became glyph+space (+1) and the latent bug where
	// the fixed cost ignored the double space before usage (15→17) is fixed.
	const total = () => 2 + nameW + 1 + 7 + 1 + branchW + 1 + 1 + 1 + 2 + 2 + usageW;
	// Shrink priority: branch → name → usage (floors keep columns readable).
	while (total() > innerW && branchW > FLEET_FLOORS.branch) {
		branchW = Math.max(FLEET_FLOORS.branch, branchW - (total() - innerW));
	}
	while (total() > innerW && nameW > FLEET_FLOORS.name) {
		nameW = Math.max(FLEET_FLOORS.name, nameW - (total() - innerW));
	}
	while (total() > innerW && usageW > FLEET_FLOORS.usage) {
		usageW = Math.max(FLEET_FLOORS.usage, usageW - (total() - innerW));
	}

	return {
		nameW,
		branchW,
		usageW,
		cells: rows.map((r) => ({
			name: trunc(pad(r.name, nameW), nameW),
			branch: trunc(pad(r.branch, branchW), branchW),
			usage: trunc(fleetUsageOf(r), usageW),
		})),
	};
}

/** Offset safety (§19 alignment fix), pure and unit-testable: clip row
 *  content to `innerW - 1` BEFORE padding to `innerW`, so nothing (header,
 *  legend, themed rows) can ever push past the right border. */
export function fitRow(content: string, innerW: number): string {
	return pad(trunc(content, innerW - 1), innerW);
}

// ---------------------------------------------------------------------------
// Grouping — ownership/task tree (fleet-UX stage 2, report-ux-tree.json).
// Pure: no fs, no transport, no theme. Unit-tested in test/fleet-tree-check.ts.
// ---------------------------------------------------------------------------

/** Structural slice the grouping + header/folded lines need (FleetRow
 *  satisfies it; tests build it directly). */
export interface GroupStatsRow {
	view: Pick<WorkerView, "name" | "dir" | "status" | "reportExists">;
	/** Per-row ownership class (stage 1) — the group class derives from it. */
	ownership: Ownership;
	/** Owner session JSONL (v1.11.1+); undefined = legacy → unknown bucket. */
	orchestratorSessionPath?: string;
	/** Context-window burn % (0 = unknown). */
	percent: number;
	mail: "Q?" | "A→" | "--";
	/** ISO 8601 collect stamp (v1.12.1) — stale age tail input (§22);
	 *  absent when the worker was never collected. */
	collectedAt?: string;
}

export type GroupClass = "mine" | "foreign" | "owner?";

export interface WorkerGroup<T extends GroupStatsRow = GroupStatsRow> {
	/** `manifest.dir :: orchestratorSessionPath` (unknown bucket for legacy). */
	key: string;
	dir: string;
	/** basename(dir) — the human handle in headers/folded lines. */
	slug: string;
	cls: GroupClass;
	/** Members in encounter order (feed pre-sorted rows: sortViews holds). */
	rows: T[];
}

const UNKNOWN_SESSION = "unknown";

/** More than this many foldable groups → one mega-line (ux-fold §1 guard). */
export const MEGA_GROUP_LIMIT = 6;

/** The folded group's stale age tail shares the watcher's worker-stale
 *  default: collected ≥30 min ago = stale-idle (§22). */
// W2 deviation (orchestrator-approved), audited and made permanent in W5,
// re-justified in W6: duplicated literal instead of importing
// WATCH_DEFAULT_STALE_AFTER_MS from src/observe.ts — importing it would
// re-create the fleet<->observe cycle (observe imports these render
// helpers), and reading an observe const at module-eval time inside that
// cycle crashes with a TDZ ReferenceError whenever observe is evaluated
// first (index.ts and the watcher-side suites). Keep in sync with
// WATCH_DEFAULT_STALE_AFTER_MS in src/observe.ts (watch section).
export const FLEET_STALE_AFTER_MS = 30 * 60_000;

function slugOf(dir: string): string {
	const parts = dir.split("/").filter((p) => p.length > 0);
	return parts[parts.length - 1] ?? dir;
}

/**
 * Group rows by `manifest.dir :: orchestratorSessionPath` (report-ux-tree
 * dataMapping). Legacy manifests (field absent) land in the per-dir UNKNOWN
 * bucket — never merged into a named session's group, so the same dir can
 * legitimately split into mine/owner?/foreign groups. Within-group order is
 * the input order. Group class from members: any mine → "mine" (renders
 * FLAT — zero regression, and per-row glyphs keep telling the truth in the
 * degraded-self-id mixed edge); else any unknown → "owner?" (fail-open:
 * unknown is NEVER labeled "foreign"); else "foreign".
 */
export function groupWorkerViews<T extends GroupStatsRow>(rows: T[]): WorkerGroup<T>[] {
	const byKey = new Map<string, WorkerGroup<T>>();
	for (const r of rows) {
		const key = `${r.view.dir} :: ${r.orchestratorSessionPath ?? UNKNOWN_SESSION}`;
		let g = byKey.get(key);
		if (!g) byKey.set(key, (g = { key, dir: r.view.dir, slug: slugOf(r.view.dir), cls: "foreign", rows: [] }));
		g.rows.push(r);
	}
	const groups = [...byKey.values()];
	for (const g of groups) {
		g.cls = g.rows.some((r) => r.ownership === "mine")
			? "mine"
			: g.rows.some((r) => r.ownership === "unknown")
				? "owner?"
				: "foreign";
	}
	return groups;
}

const CLASS_RANK: Record<GroupClass, number> = { mine: 0, "owner?": 1, foreign: 2 };

/** Per-group sort (replaces the global status sort): groups ranked by their
 *  most actionable member (existing STATUS_ORDER); ties mine < owner? <
 *  foreign; then ONE new layer (fleet-UX wave 4): fully-stale groups (every
 *  member collected ≥30 min ago — the §22.3 condition, semantics unchanged)
 *  sort below otherwise-equal fresh ones; then slug. Stable — within-group
 *  order untouched. */
export function rankGroups<T extends GroupStatsRow>(
	groups: WorkerGroup<T>[],
	nowMs: number = Date.now(),
): WorkerGroup<T>[] {
	const actionability = (g: WorkerGroup<T>) => Math.min(...g.rows.map((r) => STATUS_ORDER[r.view.status]));
	const fullyStale = (g: WorkerGroup<T>) =>
		g.rows.length > 0 && g.rows.every((r) => isFleetStale(r.collectedAt, nowMs));
	return [...groups].sort(
		(a, b) =>
			actionability(a) - actionability(b) ||
			CLASS_RANK[a.cls] - CLASS_RANK[b.cls] ||
			Number(fullyStale(a)) - Number(fullyStale(b)) ||
			a.slug.localeCompare(b.slug),
	);
}

/** Expanded group header (one full-width dim line, NOT in the column grid):
 *  `▼ slug · live/total live · owner · ctx↑max%`. ctx is the MAX across
 *  members (the restart-cliff E_CONTEXT cares about — not mean/sum), the
 *  segment is dropped when no member has a known pct. fitRow degrades it
 *  left-to-right by survival value at the 40-col box minimum. */
export function groupHeaderText(
	g: Pick<WorkerGroup, "slug" | "cls">,
	rows: ReadonlyArray<GroupStatsRow>,
): string {
	const live = rows.filter((r) => r.view.status === "working" || r.view.status === "blocked").length;
	const maxPct = rows.reduce((m, r) => Math.max(m, r.percent), 0);
	const ctx = maxPct > 0 ? ` · ctx↑${maxPct}%` : "";
	return `▼ ${g.slug} · ${live}/${rows.length} live · ${g.cls}${ctx}`;
}

/**
 * Stale condition (v1.12.1, §22): the worker was COLLECTED (a valid report
 * was delivered — manifest `collectedAt`) at least FLEET_STALE_AFTER_MS ago.
 * Absent/empty/unparseable/future stamps → false: a flag is a claim, and an
 * unknown stamp never reads as stale. Pure.
 */
export function isFleetStale(collectedAt: string | undefined, nowMs: number): boolean {
	if (typeof collectedAt !== "string" || collectedAt.length === 0) return false;
	const t = Date.parse(collectedAt);
	return Number.isFinite(t) && nowMs - t >= FLEET_STALE_AFTER_MS;
}

/** Human age for the stale tail: `31m` under an hour, else hours+minutes
 *  (`3h46m`); sub-minute/negative reads as `0m`. Pure. */
export function fleetAgeText(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0m";
	const m = Math.floor(ms / 60_000);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** Non-zero-only count segments of the folded grammar (fleet-UX wave 4,
 *  report-lex): the letter flags L B ! Q v spelled out as words, same order,
 *  same non-zero-only rule. blocked / hot-ctx (≥CONTEXT_WARN_PCT) /
 *  question surface only when present; `rep` = report landed. */
function countSegments(rows: ReadonlyArray<GroupStatsRow>): string[] {
	let live = 0,
		blocked = 0,
		hot = 0,
		mailQ = 0,
		reports = 0;
	for (const r of rows) {
		if (r.view.status === "working" || r.view.status === "blocked") live++;
		if (r.view.status === "blocked") blocked++;
		if (r.percent >= CONTEXT_WARN_PCT) hot++;
		if (r.mail === "Q?") mailQ++;
		if (r.view.reportExists) reports++;
	}
	const segs: string[] = [];
	if (live > 0) segs.push(`${live} live`);
	if (blocked > 0) segs.push(`${blocked} blocked`);
	if (hot > 0) segs.push(`${hot} hot-ctx`);
	if (mailQ > 0) segs.push(`${mailQ} question`);
	if (reports > 0) segs.push(`${reports} rep`);
	return segs;
}

/**
 * Stale age tail (fleet-UX wave 4, §22.3): when EVERY member was collected
 * ≥FLEET_STALE_AFTER_MS ago (the retired `s` letter's exact condition —
 * isFleetStale, semantics unchanged), the tail spells the OLDEST member's
 * collectedAt age in human form. The remedy is OWNERSHIP-SCOPED (report-act):
 * /delegate-teardown is a global sweep with no ownership filter, so it is
 * advertised only on MINE groups; foreign/owner? groups point at the owner.
 */
function staleAgeTail(cls: GroupClass, rows: ReadonlyArray<GroupStatsRow>, nowMs: number): string {
	const stale = rows.length > 0 && rows.every((r) => isFleetStale(r.collectedAt, nowMs));
	if (!stale) return "";
	let oldest = Number.POSITIVE_INFINITY;
	for (const r of rows) {
		const t = Date.parse(r.collectedAt ?? "");
		if (Number.isFinite(t) && t < oldest) oldest = t;
	}
	if (!Number.isFinite(oldest)) return ""; // unreachable while stale, but a claim is only ever a claim
	const age = fleetAgeText(nowMs - oldest);
	return cls === "mine"
		? ` · idle ${age} (/delegate-teardown)`
		: ` · idle ${age} · owner can tear down`;
}

/** Folded group line (fleet-UX wave 4, report-lex): self-describing
 *  grammar `~ <class> <slug> · N workers · counts… · idle <age>` — the
 *  class token is SPACE-separated (the dot-join read as a hostname), there
 *  are no bare `xN` counts, no `--` separator and no letter flags; counts
 *  are words a stranger can parse (live / blocked / hot-ctx / question /
 *  rep), non-zero only. Identity (class + slug + worker count) LEADS, so
 *  fitRow's left-to-right degrade keeps it under width pressure. The
 *  `Tab` hint lives in the overlay header (§4), not per-line. */
export function groupFoldedText(
	g: Pick<WorkerGroup, "slug" | "cls">,
	rows: ReadonlyArray<GroupStatsRow>,
	nowMs: number = Date.now(),
): string {
	const n = rows.length;
	const segs = [`~ ${g.cls} ${g.slug}`, `${n} worker${n === 1 ? "" : "s"}`, ...countSegments(rows)];
	return segs.join(" · ") + staleAgeTail(g.cls, rows, nowMs);
}

/** Mega-line guard (>MEGA_GROUP_LIMIT foldable groups): ONE line, same
 *  self-describing vocabulary as groupFoldedText. Tags stay honest:
 *  "owner?" groups are never folded into a plain "foreign" label — a mixed
 *  collapse says so. The mega collapse holds only non-mine groups, so the
 *  stale tail carries the owner-side remedy (never the /delegate-teardown
 *  hint — that sweep is global). */
export function megaFoldedText(
	groups: ReadonlyArray<WorkerGroup>,
	nowMs: number = Date.now(),
): string {
	const rows = groups.flatMap((g) => g.rows);
	const hasForeign = groups.some((g) => g.cls === "foreign");
	const hasOwner = groups.some((g) => g.cls === "owner?");
	const tag = hasForeign && hasOwner ? "foreign+owner?" : hasOwner ? "owner?" : "foreign";
	const segs = [`~ ${tag}`, `${rows.length} workers in ${groups.length} tasks`, ...countSegments(rows)];
	return segs.join(" · ") + staleAgeTail("foreign", rows, nowMs);
}

// ---------------------------------------------------------------------------
// Tab fold state (report-ux-fold §4 exact): module-level boolean = session
// scope — survives overlay close/reopen, resets on restart. NOT persisted to
// /tmp/exchange (surfaces are read-only by contract). FOLDED is the
// first-open default: opening the overlay must never show MORE than today's
// flat table under a foreign fleet.
// ---------------------------------------------------------------------------

let foreignUnfolded = false;

/** Toggle on Tab; no-op when nothing is foldable (foldableCount === 0). */
export function fleetFoldToggle(foldableCount: number): void {
	if (foldableCount > 0) foreignUnfolded = !foreignUnfolded;
}

/** Current fold state (true = foreign/unknown groups expanded). */
export function fleetFoldUnfolded(): boolean {
	return foreignUnfolded;
}

// ---------------------------------------------------------------------------
// Pure overlay skin (stage 2): grouping + tree glyphs + fold + group-atomic
// window. FleetOverlay.render is a thin delegate; tests render headless.
// ---------------------------------------------------------------------------

export interface FleetRenderInput {
	/** Pre-sorted rows (sortViews order — grouping preserves it). */
	rows: FleetRow[];
	/** Terminal width; the box clamps to 40..100 as before. */
	width: number;
	terminalRows?: number;
	/** Fold state (fleetFoldUnfolded()). */
	unfolded: boolean;
	/** Injectable clock for the stale age tail + ordering/trim tiebreak
	 *  (v1.12.1+) — tests pin it; production defaults to Date.now() at
	 *  render time. */
	nowMs?: number;
	theme: Theme;
}

type FleetBlock =
	| { kind: "row"; r: FleetRow; stale: boolean }
	| { kind: "group"; g: WorkerGroup<FleetRow>; stale: boolean }
	| { kind: "folded"; g: WorkerGroup<FleetRow>; stale: boolean }
	| { kind: "mega"; workers: number; stale: boolean };

// --- Legends (fleet-UX wave 4) --------------------------------------------
// Each legend is a list of atomic segments greedily packed into at most TWO
// physical dim lines (one when everything fits — packLegend). FLAT keys
// every token its expanded surface renders, incl. the wave-4 parity keys
// `owner?` untraceable, the probe em-dash, tree glyphs and token arrows
// (report-lex fix 3). FOLD is a WORKED EXAMPLE of the folded grammar plus a
// minimal key for the non-obvious tokens — not a token list.

const FLAT_LEGEND_SEGS = [
	"● mine ○ foreign ◌ owner? untraceable",
	"blocked→working→idle→done→unknown",
	"✓/✗ report",
	"— probe",
	"Q?/A→ mailbox",
	"├└ group",
	"↑↓ in/out",
	"2s refresh",
] as const;

const FOLD_LEGEND_SEGS = [
	"● yours",
	"e.g. ~ foreign prod-prep · 4 workers · 2 live · 2 rep · idle 31m",
	"live=working/blocked",
	"rep=report landed",
	"idle=collected ≥30m",
] as const;

/** Foreign-fleet framing (report-act fix 1): states the viewer's role —
 *  rendered once whenever any foreign/owner? group is on screen. Affirms
 *  the §22 canon (foreign fleets never mutated) instead of weakening it. */
const FOREIGN_FRAMING = "○ ◌ = another session's fleet — informational; only its owner can act";

/** Greedy-pack legend segments into ≤2 lines that each fit the row budget
 *  (innerW − 2: the legend line's leading render space + fitRow's 1-col
 *  clip margin). The second line may overflow — fitRow clips it, degrade
 *  stays left-to-right. One line when everything fits; never more than
 *  two. Pure. */
export function packLegend(segs: ReadonlyArray<string>, innerW: number): string[] {
	const budget = Math.max(1, innerW - 2);
	const first: string[] = [];
	let i = 0;
	for (; i < segs.length; i++) {
		const next = first.length === 0 ? segs[i] : `${first.join(" · ")} · ${segs[i]}`;
		if (visibleWidth(next) > budget) break;
		first.push(segs[i]);
	}
	const rest = segs.slice(i).join(" · ");
	if (first.length === 0) return [rest]; // single wider-than-line segment → one trunc'd line
	if (rest.length === 0) return [first.join(" · ")];
	return [first.join(" · "), rest];
}

/**
 * Render the overlay: pass 1 builds BLOCKS (mine rows are singletons; a
 * foldable group is its header + ALL children — the height window is
 * group-atomic, a header never shows without its children, so a block that
 * does not fit hides whole); pass 2 fits the column grid over the VISIBLE
 * rows only, with inline tree glyphs `├ `/`└ ` in the name column (V1,
 * report-ux-tree: fitter untouched, glyph truncates as one unit with the
 * name). Group headers/folded lines are full-width dim lines OUTSIDE the
 * grid. Every line goes through fitRow → visibleWidth ≤ innerW.
 */
export function renderFleet(input: FleetRenderInput): string[] {
	const th = input.theme;
	const w = Math.max(40, Math.min(input.width, 100));
	const innerW = w - 2;
	const row = (content: string) => th.fg("border", "│") + fitRow(content, innerW) + th.fg("border", "│");

	const nowMs = input.nowMs ?? Date.now();
	const groups = rankGroups(groupWorkerViews(input.rows), nowMs);
	const foldables = groups.filter((g) => g.cls !== "mine");
	const folded = foldables.length > 0 && !input.unfolded;
	const mega = folded && foldables.length > MEGA_GROUP_LIMIT;
	const fullyStale = (g: WorkerGroup<FleetRow>) =>
		g.rows.length > 0 && g.rows.every((r) => isFleetStale(r.collectedAt, nowMs));

	const blocks: FleetBlock[] = [];
	for (const g of groups) {
		const st = fullyStale(g);
		if (g.cls === "mine") for (const r of g.rows) blocks.push({ kind: "row", r, stale: st });
		else if (!mega) blocks.push(folded ? { kind: "folded", g, stale: st } : { kind: "group", g, stale: st });
	}
	if (mega) {
		blocks.push({
			kind: "mega",
			workers: foldables.reduce((n, g) => n + g.rows.length, 0),
			stale: foldables.length > 0 && foldables.every(fullyStale),
		});
	}

	const blockLines = (b: FleetBlock) => (b.kind === "group" ? 1 + b.g.rows.length : 1);
	const blockWorkers = (b: FleetBlock) =>
		b.kind === "row" ? 1 : b.kind === "mega" ? b.workers : b.g.rows.length;

	// Legends/frame are computed before the window math: they decide the
	// chrome height. Framing renders whenever any foreign/owner? group is on
	// screen (report-act fix 1).
	const legendLines = packLegend(folded ? FOLD_LEGEND_SEGS : FLAT_LEGEND_SEGS, innerW);
	const framing = foldables.length > 0;

	// Height fit (§15 fix + fleet-UX wave 4): chrome = top border + header +
	// blank + blank + legend (1–2 lines) + framing? + bottom border; the
	// extra −2 is the “… and N more” slot plus render slack. Group-atomic: a
	// block that would not fit entirely hides whole. Stale-aware trim
	// (report-pulse fix 2): FRESH blocks fill the window first in display
	// order; fully-stale blocks are admitted only into what remains AFTER
	// every fresh block is shown — so a live (working/blocked) row is never
	// hidden while any stale-group row is visible. Display order is
	// unchanged; shown blocks render at their ranked positions.
	const chromeLines = 5 + legendLines.length + (framing ? 1 : 0);
	const maxVisible = Math.max(1, (input.terminalRows ?? 30) - chromeLines - 2);
	const fresh: Array<[number, FleetBlock]> = [];
	const staleBlocks: Array<[number, FleetBlock]> = [];
	blocks.forEach((b, i) => (b.stale ? staleBlocks : fresh).push([i, b]));
	const shownIdx: number[] = [];
	let used = 0;
	let freshAllShown = true;
	for (const [i, b] of fresh) {
		const n = blockLines(b);
		if (used + n > maxVisible) {
			freshAllShown = false;
			break;
		}
		shownIdx.push(i);
		used += n;
	}
	if (freshAllShown) {
		for (const [i, b] of staleBlocks) {
			const n = blockLines(b);
			if (used + n > maxVisible) break;
			shownIdx.push(i);
			used += n;
		}
	}
	shownIdx.sort((a, b) => a - b);
	const shown = shownIdx.map((i) => blocks[i]);
	const shownWorkers = shown.reduce((n, b) => n + blockWorkers(b), 0);
	const hiddenWorkers = input.rows.length - shownWorkers;

	const visible: Array<{ r: FleetRow; name: string }> = [];
	for (const b of shown) {
		if (b.kind === "row") visible.push({ r: b.r, name: b.r.view.name });
		else if (b.kind === "group") {
			const n = b.g.rows.length;
			b.g.rows.forEach((r, i) => visible.push({ r, name: `${i < n - 1 ? "├" : "└"} ${r.view.name}` }));
		}
	}
	const layout = layoutFleetRows(
		visible.map((v) => ({
			name: v.name,
			branch: v.r.view.branch ?? "-",
			input: v.r.input,
			output: v.r.output,
			percent: v.r.percent,
			budget: v.r.budget,
		})),
		innerW,
	);

	const lines: string[] = [];
	lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
	const hint = foldables.length > 0 ? ` — Tab ${input.unfolded ? "fold" : "unfold"}` : "";
	lines.push(
		row(` ${th.fg("accent", `pi-delegate fleet — ${input.rows.length} worker(s) — q to close${hint}`)}`),
	);
	lines.push(row(""));

	if (input.rows.length === 0) {
		lines.push(row(` ${th.fg("dim", "no delegate workers known (no manifests under /tmp/exchange)")}`));
	}

	let cell = 0;
	const gridRow = () => {
		const { r } = visible[cell];
		const c = layout.cells[cell];
		cell++;
		const own = ownershipGlyph(r.ownership);
		const glyph = th.fg(own.color, own.glyph);
		const name = th.fg("text", c.name);
		const status = th.fg(statusColor(r.view.status), pad7(r.view.status));
		const branch = th.fg("dim", c.branch);
		const report = r.isProbe
			? th.fg("dim", "—") // probe: no report expected — never ✓/✗ (§19.4)
			: r.view.reportExists
				? th.fg("success", "✓")
				: th.fg("error", "✗");
		const mail =
			r.mail === "Q?"
				? th.fg("warning", "Q?")
				: r.mail === "A→"
					? th.fg("success", "A→")
					: th.fg("dim", "--");
		const warn = r.percent >= CONTEXT_WARN_PCT;
		const usage = th.fg(warn ? "warning" : "dim", c.usage);
		// Row shape (the fitter's fixed cost mirrors this): glyph+space lead,
		// then name status branch report mail␣␣usage.
		return row(`${glyph} ${name} ${status} ${branch} ${report} ${mail}  ${usage}`);
	};

	for (const b of shown) {
		if (b.kind === "row") {
			lines.push(gridRow());
		} else if (b.kind === "group") {
			lines.push(row(` ${th.fg("dim", groupHeaderText(b.g, b.g.rows))}`));
			for (let i = 0; i < b.g.rows.length; i++) lines.push(gridRow());
		} else if (b.kind === "folded") {
			lines.push(row(` ${th.fg("dim", groupFoldedText(b.g, b.g.rows, nowMs))}`));
		} else {
			lines.push(row(` ${th.fg("dim", megaFoldedText(foldables, nowMs))}`));
		}
	}

	if (hiddenWorkers > 0) {
		lines.push(
			row(
				` ${th.fg("dim", trunc(`… and ${hiddenWorkers} more (trim the fleet: /delegate-teardown)`, innerW - 1))}`,
			),
		);
	}
	lines.push(row(""));
	for (const l of legendLines) lines.push(row(` ${th.fg("dim", l)}`));
	if (framing) lines.push(row(` ${th.fg("dim", FOREIGN_FRAMING)}`));
	lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

	return lines;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------

class FleetOverlay {
	private tui: RenderPoke | undefined;
	private terminalRows: number | undefined;
	private transport: Transport;
	private theme: Theme;
	private done: () => void;
	/** This session's identity — ownership is classified against it. */
	private self: SelfIdentity;
	private rows: FleetRow[] = [];
	/** Foldable groups (foreign + owner?) in the last snapshot — Tab no-ops
	 *  when 0 (ux-fold §4). Computed in refresh, cheap (rows ≤ dozens). */
	private foldableCount = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	private refreshing = false;

	constructor(tui: RenderPoke, transport: Transport, theme: Theme, done: () => void, self: SelfIdentity = {}) {
		this.tui = tui;
		this.terminalRows = tui?.terminal?.rows;
		this.transport = transport;
		this.theme = theme;
		this.done = done;
		this.self = self;
		void this.refresh();
		this.timer = setInterval(() => {
			void this.refresh().then(() => {
				if (!this.closed) this.tui?.requestRender();
			});
		}, REFRESH_MS);
	}

	/** Read-only data refresh; never throws, never overlaps. */
	private async refresh(): Promise<void> {
		if (this.closed || this.refreshing) return;
		this.refreshing = true;
		try {
			const views = sortViews(await buildWorkerView(this.transport));
			const rows: FleetRow[] = [];
			for (const view of views) {
				const [extras, mail] = await Promise.all([
					readManifestExtras(view.dir, view.name),
					mailState(view.dir, view.name),
				]);
				rows.push(buildRow(view, extras, mail, this.self));
			}
			this.rows = rows;
			this.foldableCount = groupWorkerViews(rows).filter((g) => g.cls !== "mine").length;
		} catch {
			// keep last snapshot on any unexpected read failure
		} finally {
			this.refreshing = false;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.done();
	}

	handleInput(data: string): void {
		if (data === "\t") {
			// Tab (0x09) — ux-fold §4 exact: single byte (never an ESC-sequence
			// prefix), no-op when nothing is foldable, then requestRender.
			if (this.foldableCount > 0) {
				fleetFoldToggle(this.foldableCount);
				this.tui?.requestRender();
			}
			return;
		}
		if (isEscape(data) || data === "q") {
			this.close();
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.closed = true;
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	render(width: number): string[] {
		// Pure skin (stage 2): grouping + tree + fold + group-atomic window.
		return renderFleet({
			rows: this.rows,
			width,
			terminalRows: this.terminalRows,
			unfolded: fleetFoldUnfolded(),
			theme: this.theme,
		});
	}
}

/** Pad the fixed 7-column status cell (theme-free helper). */
function pad7(s: string): string {
	return s + " ".repeat(Math.max(0, 7 - visibleWidth(s)));
}

/**
 * Open the fleet overlay and block until the user closes it (q/escape).
 * Read-only; resolves with void. Ownership glyphs classify against THIS
 * session (live sessionManager getter, tolerantly degraded — same wiring as
 * observe.ts startWatcher).
 */
export async function openFleetOverlay(ctx: ExtensionCommandContext, deps: FleetDeps): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/delegate-fleet is only available in interactive (TUI) mode.", "warning");
		return;
	}
	let sessionFile: string | undefined;
	try {
		sessionFile = ctx.sessionManager?.getSessionFile?.();
	} catch {
		sessionFile = undefined; // degraded self-id — classification degrades, overlay lives
	}
	const self: SelfIdentity = { sessionFile, cwd: ctx.cwd };
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new FleetOverlay(tui, deps.transport, theme, () => done(undefined), self),
		{ overlay: true },
	);
}

// ===========================================================================
// SECTION 5/5 — worker view aggregation
// (verbatim move from observe.ts in W6 — ex src/state.ts, its review-verified
// header comment is preserved; moved here to break the fleet<->observe import
// cycle: view-building is view code and belongs with the other view code)
// ===========================================================================

/**
 * pi-delegate — worker view aggregation (DESIGN.md §5.2).
 *
 * OWNERSHIP: worker B (impl-tools).
 *
 * Read-only module: merges durable on-disk manifests (exchange.ts) with live
 * herdr agent statuses (via the Transport seam). Contains NO mutating calls —
 * this is the data source for `delegate_status` and `/delegate-teardown`.
 */

/** One known worker, as seen by the orchestrator. */
export interface WorkerView {
	/** Canonical (herdr-confirmed) worker name. */
	name: string;
	/** Exchange dir (manifest source) this worker belongs to. */
	dir: string;
	/** Live status when herdr knows the agent, otherwise "unknown". */
	status: AgentStatusName;
	/** Full placement record from the manifest (teardown source of truth). */
	placement: Placement;
	/** Convenience projections of `placement`. */
	kind: Placement["kind"];
	branch?: string;
	workspaceId?: string;
	paneId?: string;
	/** Conventional report path for this worker. */
	reportPath: string;
	/** True when the report file currently exists on disk. */
	reportExists: boolean;
	/** True when the manifest records `retiredAt` — the worker is HISTORY
	 *  (pane already closed, by retire/teardown/manual): the teardown command
	 *  must not attempt (and fail tab_not_found) on it. */
	retired?: boolean;
	/** ISO 8601 start time from the manifest. */
	startedAt: string;
	/** Ms since startedAt (0 when unparseable). */
	elapsedMs: number;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Aggregate all known workers: every manifest under /tmp/exchange merged with
 * a live `listStatuses()` snapshot. Never throws for herdr being unreachable —
 * statuses degrade to "unknown" instead.
 */
export async function buildWorkerView(transport: Transport): Promise<WorkerView[]> {
	const manifests = scanAllManifests();

	let statuses: Awaited<ReturnType<Transport["listStatuses"]>> = [];
	try {
		// EXTERNAL_DEPENDENCY: live herdr agent statuses via the injected
		// transport (herdr socket/CLI underneath — see transport.ts).
		statuses = await transport.listStatuses();
	} catch {
		statuses = []; // herdr unreachable — fall back to manifest data only
	}
	const liveByName = new Map(statuses.map((s) => [s.name, s]));

	const views: WorkerView[] = [];
	const seen = new Set<string>();
	for (const manifest of manifests) {
		for (const worker of manifest.workers) {
			const key = `${manifest.dir}#${worker.name}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const live = liveByName.get(worker.name);
			const startedMs = Date.parse(worker.startedAt);
			views.push({
				name: worker.name,
				dir: manifest.dir,
				status: live?.status ?? "unknown",
				placement: worker.placement,
				kind: worker.placement.kind,
				branch: worker.placement.branch,
				workspaceId: worker.placement.workspaceId,
				paneId: worker.placement.paneId,
				reportPath: worker.reportPath,
				// EXTERNAL_DEPENDENCY: report file existence check on disk at
				// worker.reportPath (under /tmp/exchange/<task>/).
				reportExists: await fileExists(worker.reportPath),
				retired: typeof worker.retiredAt === "string" && worker.retiredAt.length > 0,
				startedAt: worker.startedAt,
				elapsedMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
			});
		}
	}
	return views;
}
