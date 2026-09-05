/**
 * pi-delegate — ambient fleet UI (DESIGN.md §19.4).
 *
 * OWNERSHIP: contracts authored by the tech lead; implementation owned by
 * worker B6 (impl-ui). All functions MUST be inert when the context has no UI.
 *
 * Primitives (verified in pi docs/examples, Patterns 4/5/6):
 *   ctx.ui.setWidget(id, renderer, {placement})   — live rows above editor
 *   (setFooter REJECTED — it REPLACES pi's native footer (context %, model,
 *    cost, cwd): unacceptable. The chip lives in a below-editor widget instead.)
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

import type {
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { fmtK, trunc, visibleWidth, clampLines } from "./text.ts";

/** Data the UI needs per worker — supplied by the caller (state.ts + usage.ts). */
export interface FleetRow {
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
}

export interface FleetUIDeps {
	getRows(): Promise<FleetRow[]>;
	/** How many workers are placed but not yet torn down (tab clutter count). */
	getPlacedCount(): number;
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
// Shared formatting helpers live in ui/text.ts (ONE fmtK/trunc/stripAnsi —
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

function isLive(row: FleetRow): boolean {
	return LIVE_STATUSES.has(row.status);
}

// ---------------------------------------------------------------------------
// mountFleetUI
// ---------------------------------------------------------------------------

/**
 * Mount the live fleet widget + placed-chip widget. Idempotent: calling twice
 * replaces the previous mount. Starts a 2 s refresh interval that renders
 * live workers (working/blocked) as rows above the editor; the placed-count
 * chip renders BELOW the editor (a widget — never ctx.ui.setFooter, which
 * would replace pi's native footer: context %, model, cost, cwd). The chip
 * widget clears when nothing is placed. Returns a dispose function (clears
 * timers, clears both widgets) — used by /delegate-teardown.
 */
export function mountFleetUI(ctx: ExtensionContext, deps: FleetUIDeps): () => void {
	// Headless guard: MUST work (no-op) when there is no UI.
	if (!ctx.hasUI || !ctx.ui) return () => {};

	// Idempotent double-mount: replace the previous mount.
	activeDispose?.();
	activeDispose = null;

	const WIDGET_KEY = "delegate-fleet";
	const REFRESH_MS = 2000;

	let rows: FleetRow[] = [];
	let widgetShown = false;
	let chipShown = false;
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

	const CHIP_KEY = "delegate-fleet-chip";
	const showChip = (): void => {
		ctx.ui.setWidget(
			CHIP_KEY,
			(tui, theme) => ({
				invalidate: () => {},
				render: (width?: number) => {
					const n = deps.getPlacedCount();
					if (n <= 0) return [];
					const worst = rows.reduce<number>(
						(acc, r) => (typeof r.budgetPct === "number" && r.budgetPct > acc ? r.budgetPct : acc),
						0,
					);
					const line = `⏵ ${n} placed workers · worst ctx burn ${worst}% · /delegate-fleet`;
					// Right-align to the terminal width when it is discoverable.
					const cols = (tui as { terminal?: { columns?: number } } | undefined)?.terminal?.columns;
					if (typeof cols === "number" && cols > visibleWidth(line) + 2) {
						return clampLines([theme.fg("accent", " ".repeat(cols - visibleWidth(line)) + line)], width);
					}
					return clampLines([theme.fg("accent", line)], width);
				},
			}),
			{ placement: "belowEditor" },
		);
		chipShown = true;
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
		const placed = deps.getPlacedCount();
		if (placed <= 0 && chipShown) {
			ctx.ui.setWidget(CHIP_KEY, undefined);
			chipShown = false;
		} else if (placed > 0 && !chipShown) {
			showChip();
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
			ctx.ui.setWidget(CHIP_KEY, undefined);
			// Defensive: restore the native footer if any older build replaced it.
			ctx.ui.setFooter(undefined);
		}
		if (activeDispose === dispose) activeDispose = null;
	};
	activeDispose = dispose;
	return dispose;
}

/** Themed live rows: `▲ name status ↑in ↓out P% [ping: phase]` — clamped to width. */
function renderLiveRows(rows: FleetRow[], theme: Theme, width?: number): string[] {
	const live = rows.filter(isLive);
	if (live.length === 0) return [];
	const maxW = width && width > 20 ? width - 1 : undefined;
	return live.map((r) => {
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
