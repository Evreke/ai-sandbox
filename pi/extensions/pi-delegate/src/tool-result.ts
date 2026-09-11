/**
 * pi-delegate — tool-result: the shared tool-result vocabulary + the small
 * error/sleep helpers every tool module needs — extracted verbatim from
 * spawn.ts (Wave 3, step 4; the audit's "six duplicate helper clusters"
 * finding: this is the structural kill of the byte-identical errText/
 * asDelegateError copies that used to live in spawn.ts, observe.ts's
 * commands and the watcher loop).
 * <p>
 * MODULE_CONTRACT: pure value shapes + pure helpers, zero I/O — the
 * structured tool-result contract (DESIGN.md §7: errors are RETURNED as
 * failed results with an E_* code, never thrown raw across the tool
 * boundary) plus the error→message/code coercion helpers and the
 * abort-aware sleep. Dependencies: host.ts (DelegateErrorImpl +
 * the DelegateError/DelegateErrorCode types). A leaf module: nothing here
 * imports anything but the shared types.
 * Critical invariants (moved verbatim from spawn.ts):
 *   - fail() stamps `ok: false` + the E_* code into details — the intercept
 *     and the checks read the typed field, never message text;
 *   - typedCode() reads the code off a typed DelegateErrorImpl and falls
 *     back to the positional code only for plain errors (migration stage 1,
 *     audit errors-defect 1);
 *   - sleep() resolves EARLY when the abort signal fires (the
 *     abort-detaches-never-kills discipline — the wait is cancellable,
 *     never the worker).
 */

import { DelegateErrorImpl, type DelegateError, type DelegateErrorCode } from "./host.ts";

export type ToolResult = {
	content: { type: "text"; text: string }[];
	details: Record<string, unknown>;
};

export function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function fail(code: DelegateErrorCode, text: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: false, code, ...extra } };
}

/**
 * Migration stage 1 (audit, errors-defect 1): the ERROR CODE is the error's
 * OWN property — an intercept reads the typed code off a DelegateErrorImpl
 * the adapter raised and substitutes the positional (call-site) code ONLY
 * when the failure carried none (plain Error). Before this, the start catch
 * re-flattened the adapter's distinct E_NAME back into E_START, so the
 * adapter's differentiation never reached the tool result.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: err — anything caught around a transport call; fallback — the
 *   call-site positional code
 * Output: err.code when err is a typed DelegateErrorImpl, else fallback
 * Guarantees: pure; never throws; no message-text parsing (the code is read
 *   from the typed field, never matched out of the message)
 * Raises: never
 */
export function typedCode(err: unknown, fallback: DelegateErrorCode): DelegateErrorCode {
	return err instanceof DelegateErrorImpl ? err.code : fallback;
}

export function textResult(text: string, details: Record<string, unknown>): ToolResult {
	return { content: [{ type: "text", text }], details: { ok: true, ...details } };
}

export function asDelegateError(err: unknown): DelegateError | null {
	if (err instanceof Error && typeof (err as DelegateError).code === "string") {
		return err as DelegateError;
	}
	return null;
}

/** Abort-aware sleep: resolves early when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((res) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				res();
			},
			{ once: true },
		);
	});
}
