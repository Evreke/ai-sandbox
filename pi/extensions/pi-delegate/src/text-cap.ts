/**
 * pi-delegate — text-cap: the Law 1 truncation duty for tool return paths.
 * <p>
 * MODULE_CONTRACT: pure text capping for every tool return path that can
 * carry worker-written content (delegate report summary/artifacts,
 * delegate_status rows, mailbox question bodies). Dependencies: pi's own
 * truncation helpers from @earendil-works/pi-coding-agent (Law 1: the
 * platform is the API — import, never reimplement; the DEFAULT_MAX_BYTES /
 * DEFAULT_MAX_LINES limits are pi's, not re-invented constants).
 * Critical invariants:
 *   - the full data always stays available somewhere (on disk and/or in the
 *     tool result's details) — capping only bounds the RENDERED text;
 *   - when text is cut, the LLM is TOLD what was cut and where the full
 *     copy lives (the caller supplies the pointer, rendered in pi's
 *     bracketed-notice style — the same pattern the read tool uses).
 */

import { truncateHead, formatSize } from "@earendil-works/pi-coding-agent";

/** Result of capping: the (possibly truncated) display text + honesty flag. */
export interface CappedText {
	text: string;
	truncated: boolean;
}

/**
 * Head-truncate worker-written text to pi's default limits and, when cut,
 * append a bracketed notice telling the model what was cut and where the
 * full copy lives (pi read-tool notice style).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - text: the worker-written text to render (may be arbitrarily large)
 *   - fullCopyNote: where the full copy lives, e.g.
 *     "Full report: /tmp/exchange/t/report-w.json (archived: /…/archive/…)"
 * Output: the display text; unchanged when within pi's default line/byte
 *   limits, else the head-truncated content plus the notice line
 * Guarantees:
 *   - pure; never throws on any input string
 *   - `truncated` is true exactly when a notice was appended
 * Raises: never
 */
export function capWorkerText(text: string, fullCopyNote: string): CappedText {
	const r = truncateHead(text);
	if (!r.truncated) return { text, truncated: false };
	const by =
		r.truncatedBy === "lines"
			? `showing first ${r.outputLines} of ${r.totalLines} lines`
			: `showing first ${formatSize(r.outputBytes)} of ${formatSize(r.totalBytes)}`;
	return {
		text: `${r.content}\n\n[Truncated (${by}, ${formatSize(r.maxBytes)}/${r.maxLines} lines limit). ${fullCopyNote}]`,
		truncated: true,
	};
}
