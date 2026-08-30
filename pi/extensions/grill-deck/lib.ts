/**
 * grill-deck — pure logic shared by the extension and its tests.
 *
 * Everything here is free of TUI/extension-runtime dependencies (except the
 * pi-tui escape stripper) so it can be unit-tested headlessly:
 *   - the data model (questions, answers, round records)
 *   - the security boundary: sanitization of model/user-supplied strings and
 *     defensive parsing of replayed session data (SECURITY-AUDIT.md F1/F2)
 *   - answersToText: the structured text handed back to the model (a prompt
 *     contract — wording changes are observable behavior)
 */

import { stripTerminalSequences } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------- types

export interface DeckQuestion {
	id: string;
	title: string;
	body?: string;
	choices?: string[];
	recommendation?: string;
}

export type AnswerKind = "accepted" | "choice" | "custom" | "deferred";

export interface DeckAnswer {
	id: string;
	kind: AnswerKind;
	label: string;
	choiceIndex?: number;
}

export interface RoundRecord {
	round: number;
	topic?: string;
	questions: DeckQuestion[];
	answers: DeckAnswer[];
	revised?: boolean;
}

// ---------------------------------------------------------------- security

/** A deck is a single screen — keep rounds bounded (SECURITY-AUDIT.md F4). */
export const MAX_QUESTIONS = 32;
export const MAX_FIELD_LENGTH = 2_000;

const ANSWER_KINDS: readonly AnswerKind[] = ["accepted", "choice", "custom", "deferred"];

/**
 * Strip terminal escape sequences (CSI/OSC/APC) and cap the length of any
 * string that will be rendered in the TUI, written to the widget, or persisted
 * to the session. Applied to model-supplied tool params, replayed session
 * data, and user-typed answers (defense in depth): wrapTextWithAnsi preserves
 * escape sequences and the alt-screen frame writes lines back verbatim, so
 * unsanitized SGR can spoof UI state and OSC 52 can rewrite the clipboard
 * (SECURITY-AUDIT.md F1).
 */
export function clean(value: unknown): string {
	const s = typeof value === "string" ? value : String(value ?? "");
	return stripTerminalSequences(s).slice(0, MAX_FIELD_LENGTH);
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Re-serialize a question into a sanitized, size-capped copy. */
export function sanitizeQuestion(q: {
	id?: unknown;
	title?: unknown;
	body?: unknown;
	choices?: unknown;
	recommendation?: unknown;
}): DeckQuestion {
	return {
		id: clean(q.id),
		title: clean(q.title),
		body: q.body == null ? undefined : clean(q.body),
		choices: Array.isArray(q.choices) ? q.choices.map(clean) : undefined,
		recommendation: q.recommendation == null ? undefined : clean(q.recommendation),
	};
}

/**
 * Validators for data replayed from session entries (SECURITY-AUDIT.md F2):
 * session files can be hand-edited or written by other extensions, so replayed
 * records are parsed defensively instead of blindly type-cast. Malformed items
 * are dropped individually; a record only needs a valid round number and
 * arrays to survive.
 */

export function parseQuestion(v: unknown): DeckQuestion | null {
	if (!isPlainObject(v) || typeof v.id !== "string" || typeof v.title !== "string") return null;
	return sanitizeQuestion(v);
}

export function parseAnswer(v: unknown): DeckAnswer | null {
	if (!isPlainObject(v)) return null;
	if (typeof v.id !== "string" || typeof v.label !== "string") return null;
	if (typeof v.kind !== "string" || !ANSWER_KINDS.includes(v.kind as AnswerKind)) return null;
	const answer: DeckAnswer = { id: clean(v.id), kind: v.kind as AnswerKind, label: clean(v.label) };
	if (answer.kind === "choice") {
		if (typeof v.choiceIndex !== "number" || !Number.isInteger(v.choiceIndex)) return null;
		answer.choiceIndex = v.choiceIndex;
	}
	return answer;
}

export function parseRoundRecord(v: unknown): RoundRecord | null {
	if (!isPlainObject(v)) return null;
	if (typeof v.round !== "number" || !Number.isInteger(v.round) || v.round < 1) return null;
	if (!Array.isArray(v.questions) || !Array.isArray(v.answers)) return null;
	const questions: DeckQuestion[] = [];
	for (const q of v.questions) {
		const parsed = parseQuestion(q);
		if (parsed) questions.push(parsed);
	}
	const answers: DeckAnswer[] = [];
	for (const a of v.answers) {
		const parsed = parseAnswer(a);
		if (parsed) answers.push(parsed);
	}
	const record: RoundRecord = { round: v.round, questions, answers };
	if (v.topic !== undefined) record.topic = clean(v.topic);
	if (typeof v.revised === "boolean") record.revised = v.revised;
	return record;
}

// ---------------------------------------------------------------- model contract

export function answersToText(round: number, questions: DeckQuestion[], answers: DeckAnswer[]): string {
	const byId = new Map(questions.map((q) => [q.id, q]));
	const lines = answers.map((a) => {
		const q = byId.get(a.id);
		const title = q ? ` (${q.title})` : "";
		switch (a.kind) {
			case "accepted":
				return `${a.id}${title}: accepted your recommendation — "${a.label}"`;
			case "choice":
				return `${a.id}${title}: chose option ${a.choiceIndex} — "${a.label}"`;
			case "custom":
				return `${a.id}${title}: user wrote — "${a.label}"`;
			case "deferred":
				return `${a.id}${title}: DEFERRED — user wants to decide later; treat as still open`;
		}
	});
	return [
		`Grill deck round ${round} answers:`,
		...lines,
		"",
		"Deferred questions remain open in the design tree. Recompute the frontier and start the next round by calling grill_deck again with the new frontier. When the frontier is empty, summarize the shared understanding and wait for the user's confirmation before acting on it.",
	].join("\n");
}
