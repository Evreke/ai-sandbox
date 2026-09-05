/**
 * pi-delegate — shared text helpers for UI rendering (quality fix A7).
 *
 * ONE fmtK, ONE trunc (visibleWidth-aware, wide-char safe), ONE stripAnsi.
 * Previously these were triplicated with DIVERGENT semantics across
 * ui/fleet.ts / ui/fleet-ui.ts / tools/status.ts (same names, different
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
