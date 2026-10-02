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

// ---------------------------------------------------------------- round shape contract

/**
 * Validate the shape of one sanitized question against the deck's round
 * contract (since v1.5.0):
 *   - every question carries a non-empty `choices` array, OR an empty
 *     `choices` array as the explicit open-question marker (a question with
 *     no selectable options);
 *   - a `recommendation` is only allowed on a question with non-empty choices
 *     (an open question has nothing to recommend).
 * Options must never live only in the body — the deck cannot render
 * body-embedded options as selectable items.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: q — a sanitized DeckQuestion (fields already cleaned)
 * Output: null when valid, otherwise a short human-readable reason
 * Guarantees:
 *   - pure: no I/O, no mutation
 * Raises: never
 */
export function questionShapeError(q: DeckQuestion): string | null {
	if (!Array.isArray(q.choices)) {
		return "missing `choices` — every question needs a non-empty `choices` array, or an empty one as an explicit open-question marker";
	}
	if (q.choices.length === 0 && q.recommendation != null) {
		return "this is an open question (empty `choices`), so it must not carry a `recommendation`";
	}
	return null;
}

/**
 * Validate a whole round; returns one combined error string listing every
 * invalid question (by id, 1-based position as fallback), or null when all
 * questions are valid.
 * <p>
 * FUNCTION_CONTRACT:
 * Input: questions — sanitized questions of the round
 * Output: null when valid, otherwise a combined reason for regeneration
 * Guarantees:
 *   - pure: no I/O, no mutation
 * Raises: never
 */
export function roundShapeError(questions: DeckQuestion[]): string | null {
	const problems: string[] = [];
	for (let i = 0; i < questions.length; i++) {
		const err = questionShapeError(questions[i]);
		if (err) problems.push(`"${questions[i].id || `Q${i + 1}`}" (${i + 1} of ${questions.length}): ${err}`);
	}
	return problems.length === 0 ? null : problems.join("; ");
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

/**
 * Serialize a submitted round into the structured text handed back to the
 * calling model. This is a PROMPT CONTRACT: the wording is observable
 * behavior (the model parses it to drive the next round).
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - round: 1-based round number
 *   - questions: the questions that were asked (titles joined into lines)
 *   - answers: one DeckAnswer per question, kind ∈ accepted/choice/custom/
 *     deferred
 * Output: multi-line text — header, one line per answer, and the fixed
 *   tail instructing the model to treat DEFERRED as still-open and recompute
 *   the frontier
 * Guarantees:
 *   - pure: no I/O, no sanitization (inputs are expected pre-cleaned)
 *   - unknown answer ids still render (title omitted)
 * Raises: none
 */
export function answersToText(
	round: number,
	questions: DeckQuestion[],
	answers: DeckAnswer[],
	transport: "tool" | "text" = "tool",
): string {
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
	const tail =
		transport === "tool"
			? "Deferred questions remain open in the design tree. Recompute the frontier and start the next round by calling grill_deck again with the new frontier. When the frontier is empty, summarize the shared understanding and wait for the user's confirmation before acting on it."
			: "Deferred questions remain open in the design tree. Recompute the frontier and start the next round by emitting a ```grill-round block per the fallback contract. When the frontier is empty, emit no block and close the session.";
	return [
		`Grill deck round ${round} answers:`,
		...lines,
		"",
		tail,
	].join("\n");
}

// ---------------------------------------------------------------- text-path round block (1.15.0)

/**
 * The fallback (text) transport: the model ends a round with ONE fenced
 * ```grill-round block instead of calling the tool. The extension parses it
 * at the settle boundary, renders the deck, and returns answers as a
 * custom_message. See docs/design-stage2-text-path.md (v2, §2–§4).
 */

export interface ParsedGrillQuestion {
	id?: string;
	title: string;
	body: string;
	choices: string[];
	recommendation?: string;
	op: boolean;
}

export type GrillRoundParse =
	| { kind: "no-block" }
	| { kind: "ok"; topic?: string; questions: ParsedGrillQuestion[] }
	| { kind: "invalid"; error: string };

const FENCE_OPEN_RE = /^```grill-round(?=$|[ \t])/m;
const FENCE_CLOSE_RE = /^```[ \t]*$/m;
const TAG_RE = /<(\/?)([a-z-]+)((?:\s+[a-z-]+="[^"]*")*)\s*(\/?)>/y;
const BACKTICKS_RE = /```/;

function unescapeXml(text: string): string {
	// &amp; LAST so "&amp;lt;" becomes "&lt;", not "<".
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function lineOf(xml: string, pos: number): number {
	return xml.slice(0, pos).split("\n").length;
}

function extractGrillRoundBlocks(text: string): { kind: "none" } | { kind: "ok"; blocks: Array<{ content: string; fenceTopic?: string }> } | { kind: "invalid"; error: string } {
	// Content inside 4+ backtick fences belongs to an outer code block — not
	// our anchor (the anchor is exactly ```grill-round). Strip those regions
	// before scanning, so a wrapped block is simply not seen.
	const lines: string[] = [];
	let outerFence = false;
	for (const line of text.split("\n")) {
		if (/^`{4,}/.test(line)) {
			outerFence = !outerFence;
			continue;
		}
		if (!outerFence) lines.push(line);
	}
	const scoped = lines.join("\n");
	const blocks: Array<{ content: string; fenceTopic?: string }> = [];
	let searchFrom = 0;
	for (;;) {
		const openMatch = FENCE_OPEN_RE.exec(scoped.slice(searchFrom));
		if (!openMatch) break;
		const openStart = searchFrom + openMatch.index;
		const lineEnd = scoped.indexOf("\n", openStart);
		if (lineEnd < 0) {
			return { kind: "invalid", error: "grill-round block is not closed (missing a ``` line)" };
		}
		const fenceLine = scoped.slice(openStart, lineEnd);
		const topicMatch = /\btopic="([^"]*)"/.exec(fenceLine.slice("```grill-round".length));
		const fenceTopic = topicMatch ? unescapeXml(topicMatch[1]) : undefined;
		const contentStart = lineEnd + 1;
		const closeMatch = FENCE_CLOSE_RE.exec(scoped.slice(contentStart));
		if (!closeMatch) {
			return { kind: "invalid", error: "grill-round block is not closed (missing a ``` line)" };
		}
		blocks.push({ content: scoped.slice(contentStart, contentStart + closeMatch.index), fenceTopic });
		searchFrom = contentStart + closeMatch.index + closeMatch[0].length;
	}
	if (blocks.length === 0) return { kind: "none" };
	return { kind: "ok", blocks };
}

interface TagToken {
	kind: "tag";
	closing: boolean;
	name: string;
	attrs: Record<string, string>;
	selfClosing: boolean;
	pos: number;
}

interface TextToken {
	kind: "text";
	text: string;
	pos: number;
}

function tokenizeXml(xml: string): { kind: "ok"; tokens: Array<TagToken | TextToken> } | { kind: "invalid"; error: string } {
	const tokens: Array<TagToken | TextToken> = [];
	let pos = 0;
	for (;;) {
		const next = xml.indexOf("<", pos);
		if (next < 0) {
			if (pos < xml.length) tokens.push({ kind: "text", text: xml.slice(pos), pos });
			return { kind: "ok", tokens };
		}
		if (next > pos) tokens.push({ kind: "text", text: xml.slice(pos, next), pos });
		TAG_RE.lastIndex = next;
		const m = TAG_RE.exec(xml);
		if (!m || m.index !== next) {
			return { kind: "invalid", error: `malformed tag at line ${lineOf(xml, next)}: unescaped '<' (use &lt;) or a malformed attribute (escape " as &quot;)` };
		}
		const attrs: Record<string, string> = {};
		const attrSource = (m[3] ?? "").trim();
		if (attrSource) {
			let rest = attrSource;
			for (;;) {
				const a = /^([a-z-]+)="([^"]*)"/.exec(rest);
				if (!a) {
					return { kind: "invalid", error: `malformed attribute at line ${lineOf(xml, next)} — quote values and escape " as &quot;` };
				}
				attrs[a[1]] = unescapeXml(a[2]);
				rest = rest.slice(a[0].length).replace(/^\s+/, "");
				if (!rest) break;
			}
		}
		tokens.push({ kind: "tag", closing: m[1] === "/", name: m[2], attrs, selfClosing: m[4] === "/", pos: next });
		pos = next + m[0].length;
	}
}

const GRILL_TAGS = new Set(["grill-round", "question", "body", "choice", "recommendation", "open"]);

function parseGrillXml(xml: string, fenceTopic?: string): { kind: "ok"; topic?: string; questions: ParsedGrillQuestion[] } | { kind: "invalid"; error: string } {
	const tokenized = tokenizeXml(xml);
	if (tokenized.kind === "invalid") return tokenized;
	const tokens = tokenized.tokens;
	// Topic precedence: the <grill-round topic> attribute wins over the fence
	// line's topic="…"; the wrapper element itself is OPTIONAL (questions may
	// sit directly in the fence — the skill example shows that shape).
	let topic = fenceTopic;
	let sawWrapper = false;
	const questions: ParsedGrillQuestion[] = [];
	let current: ParsedGrillQuestion | null = null;
	let capture: { tag: "body" | "choice" | "recommendation"; buffer: string; pos: number } | null = null;
	const seenIds = new Set<string>();

	const fail = (message: string): { kind: "invalid"; error: string } => ({ kind: "invalid", error: message });

	for (const token of tokens) {
		if (token.kind === "text") {
			const text = token.text;
			if (BACKTICKS_RE.test(text)) return fail("``` inside the block breaks the fence (line " + lineOf(xml, token.pos) + ") — use indentation for code");
			if (capture) capture.buffer += text;
			else if (text.trim()) return fail(`unexpected text outside elements at line ${lineOf(xml, token.pos)}`);
			continue;
		}
		if (token.closing) {
			if (token.name === "body" || token.name === "choice" || token.name === "recommendation") {
				if (!capture || capture.tag !== token.name) return fail(`unexpected </${token.name}> at line ${lineOf(xml, token.pos)}`);
				const value = unescapeXml(capture.buffer).trim();
				if (!value) return fail(`empty <${token.name}> at line ${lineOf(xml, token.pos)}`);
				if (token.name === "body") current!.body = value;
				else if (token.name === "choice") current!.choices.push(value);
				else current!.recommendation = value;
				capture = null;
				continue;
			}
			if (token.name === "question") {
				if (!current) return fail(`unexpected </question> at line ${lineOf(xml, token.pos)}`);
				questions.push(current);
				current = null;
				continue;
			}
			if (token.name === "grill-round") {
				continue; // optional wrapper close — tolerated, no state
			}
			return fail(`unexpected </${token.name}> at line ${lineOf(xml, token.pos)}`);
		}
		// opening tag
		if (!GRILL_TAGS.has(token.name)) return fail(`unknown element <${token.name}> at line ${lineOf(xml, token.pos)}`);
		if (token.name === "grill-round") {
			if (sawWrapper) return fail(`nested <grill-round> at line ${lineOf(xml, token.pos)}`);
			sawWrapper = true;
			if (token.attrs.topic) topic = unescapeXml(token.attrs.topic);
			continue;
		}
		if (token.name === "question") {
			if (current) return fail(`nested <question> at line ${lineOf(xml, token.pos)}`);
			const title = token.attrs.title ? unescapeXml(token.attrs.title) : "";
			if (!title) return fail(`<question> without a title at line ${lineOf(xml, token.pos)}`);
			const id = token.attrs.id ? unescapeXml(token.attrs.id) : undefined;
			if (id && seenIds.has(id)) return fail(`duplicate question id "${id}" at line ${lineOf(xml, token.pos)}`);
			if (id) seenIds.add(id);
			current = { id, title, body: "", choices: [], open: false };
			if (token.selfClosing) {
				questions.push(current);
				current = null;
			}
			continue;
		}
		if (!current) return fail(`<${token.name}> outside <question> at line ${lineOf(xml, token.pos)}`);
		if (token.name === "open") {
			if (current.open) return fail(`duplicate <open/> at line ${lineOf(xml, token.pos)}`);
			current.open = true;
			continue;
		}
		if (token.name === "body" || token.name === "choice" || token.name === "recommendation") {
			if (capture) return fail(`nested <${token.name}> at line ${lineOf(xml, token.pos)}`);
			capture = { tag: token.name, buffer: "", pos: token.pos };
		}
	}
	if (capture) return fail(`unclosed <${capture.tag}> (opened at line ${lineOf(xml, capture.pos)})`);
	if (current) return fail("unclosed <question>");
	return { kind: "ok", topic, questions };
}

/**
 * Parse the full text-path round payload out of an assistant message.
 * Exactly one fenced ```grill-round block is expected; zero blocks is the
 * valid "no questions" state. Shape rules mirror roundShapeError: every
 * question needs <choice> entries or <open/> (never both), and a
 * <recommendation> only with <choice> entries.
 */
export function parseGrillRound(text: string): GrillRoundParse {
	const extracted = extractGrillRoundBlocks(text);
	if (extracted.kind === "none") return { kind: "no-block" };
	if (extracted.kind === "invalid") return extracted;
	if (extracted.blocks.length > 1) {
		return { kind: "invalid", error: `expected exactly one grill-round block, found ${extracted.blocks.length}` };
	}
	const parsed = parseGrillXml(extracted.blocks[0].content, extracted.blocks[0].fenceTopic);
	if (parsed.kind === "invalid") return parsed;
	for (const q of parsed.questions) {
		if (q.open && (q.choices.length > 0 || q.recommendation != null)) {
			return { kind: "invalid", error: `question "${q.id ?? q.title}" is open (<open/>) but carries choices or a recommendation` };
		}
		if (!q.open && q.choices.length === 0) {
			return { kind: "invalid", error: `question "${q.id ?? q.title}" has neither <choice> entries nor <open/>` };
		}
	}
	return { kind: "ok", topic: parsed.topic, questions: parsed.questions };
}

/**
 * Fill missing question ids the same way the tool path does (Q1, Q2, …) and
 * return the ids that collide after filling (empty list = fine).
 */
export function fillMissingIds(questions: ParsedGrillQuestion[]): string[] {
	const seen = new Map<string, number>();
	const duplicates: string[] = [];
	questions.forEach((q, i) => {
		if (!q.id) q.id = `Q${i + 1}`;
		const n = (seen.get(q.id) ?? 0) + 1;
		seen.set(q.id, n);
		if (n === 2) duplicates.push(q.id);
	});
	return duplicates;
}
