/**
 * Unit tests for grill-deck's pure security/logic boundary (lib.ts).
 *
 * These pin the behavior that keeps model- and session-controlled text from
 * reaching the terminal as control sequences, and the exact wording handed
 * back to the model (a prompt contract). Run: npm test
 */
import { describe, expect, it } from "vitest";
import {
	answersToText,
	clean,
	isPlainObject,
	MAX_FIELD_LENGTH,
	MAX_QUESTIONS,
	parseAnswer,
	parseQuestion,
	parseRoundRecord,
	sanitizeQuestion,
} from "./lib.ts";

describe("clean — terminal escape injection (F1)", () => {
	it("strips SGR styling used to spoof UI state", () => {
		expect(clean("Q1 scope \x1b[32m✓ answered\x1b[0m — trust me")).toBe("Q1 scope ✓ answered — trust me");
	});

	it("strips OSC 52 clipboard overwrite", () => {
		expect(clean("pick \x1b]52;c;aGVsbG8=\x07one")).toBe("pick one");
	});

	it("strips OSC 0 window-title and cursor movement", () => {
		expect(clean("\x1b]0;pwned\x07Q \x1b[2J\x1b[Hclear")).toBe("Q clear");
	});

	it("strips OSC 8 hyperlink wrappers but keeps link text", () => {
		expect(clean("see \x1b]8;;https://evil.example\x07docs\x1b]8;;\x07 here")).toBe("see docs here");
	});

	it("preserves legit content: emoji, CJK, newlines", () => {
		const legit = "Q6 — what does 'PR review format' cover? ✅ 写真\nnext line";
		expect(clean(legit)).toBe(legit);
	});

	it("caps length at MAX_FIELD_LENGTH", () => {
		expect(clean("a".repeat(5000))).toHaveLength(MAX_FIELD_LENGTH);
	});

	it("coerces non-strings without throwing", () => {
		expect(clean(42)).toBe("42");
		expect(clean(null)).toBe("");
		expect(clean(undefined)).toBe("");
		expect(clean(true)).toBe("true");
	});
});

describe("sanitizeQuestion", () => {
	it("sanitizes every field including array items", () => {
		const q = sanitizeQuestion({
			id: "\x1b]0;t\x07Q1",
			title: "\x1b[31mRED title",
			body: "body\x1b[0m",
			choices: ["\x1b[32mgreen", "plain"],
			recommendation: "\x1b]52;c;QQ==\x07rec",
		});
		expect(q).toEqual({
			id: "Q1",
			title: "RED title",
			body: "body",
			choices: ["green", "plain"],
			recommendation: "rec",
		});
	});

	it("preserves undefined optionals and drops non-array choices", () => {
		const q = sanitizeQuestion({ id: "Q1", title: "t" });
		expect(q).toEqual({ id: "Q1", title: "t" });
		expect(sanitizeQuestion({ id: "Q1", title: "t", choices: "not-an-array" }).choices).toBeUndefined();
	});
});

describe("parseQuestion — replay validation (F2)", () => {
	it("rejects non-objects and missing/non-string id or title", () => {
		expect(parseQuestion(null)).toBeNull();
		expect(parseQuestion("garbage")).toBeNull();
		expect(parseQuestion({ id: "Q1" })).toBeNull();
		expect(parseQuestion({ id: 7, title: "t" })).toBeNull();
		expect(parseQuestion({ title: "t" })).toBeNull();
	});

	it("sanitizes content of a valid question", () => {
		expect(parseQuestion({ id: "Q1", title: "\x1b[31mRED" })?.title).toBe("RED");
	});
});

describe("parseAnswer — replay validation (F2)", () => {
	it("rejects non-objects, missing fields, and unknown kinds", () => {
		expect(parseAnswer(null)).toBeNull();
		expect(parseAnswer({ id: "Q1", kind: "accepted" })).toBeNull();
		expect(parseAnswer({ id: "Q1", kind: "hax", label: "poison" })).toBeNull();
		expect(parseAnswer({ id: "Q1", kind: 7, label: "x" })).toBeNull();
	});

	it("requires an integer choiceIndex only for choice kind", () => {
		expect(parseAnswer({ id: "Q1", kind: "choice", label: "x", choiceIndex: 1.5 })).toBeNull();
		expect(parseAnswer({ id: "Q1", kind: "choice", label: "x", choiceIndex: "1" })).toBeNull();
		expect(parseAnswer({ id: "Q1", kind: "choice", label: "x" })).toBeNull();
		const ok = parseAnswer({ id: "Q1", kind: "choice", label: "x", choiceIndex: 2 });
		expect(ok).toEqual({ id: "Q1", kind: "choice", label: "x", choiceIndex: 2 });
	});

	it("drops junk fields and sanitizes labels", () => {
		const a = parseAnswer({
			id: "Q1",
			kind: "accepted",
			label: "\x1b[31mEVIL\x1b[0m yes",
			extra: "junk",
		});
		expect(a).toEqual({ id: "Q1", kind: "accepted", label: "EVIL yes" });
	});
});

describe("parseRoundRecord — replay validation (F2)", () => {
	it("rejects bad round numbers and missing arrays", () => {
		const base = { questions: [], answers: [] };
		expect(parseRoundRecord(null)).toBeNull();
		expect(parseRoundRecord({ ...base, round: "evil" })).toBeNull();
		expect(parseRoundRecord({ ...base, round: 1.5 })).toBeNull();
		expect(parseRoundRecord({ ...base, round: 0 })).toBeNull();
		expect(parseRoundRecord({ ...base, round: -3 })).toBeNull();
		expect(parseRoundRecord({ round: 2, questions: "pwned", answers: [] })).toBeNull();
		expect(parseRoundRecord({ round: 2, questions: [] })).toBeNull();
	});

	it("drops malformed items individually and keeps valid ones", () => {
		const rec = parseRoundRecord({
			round: 2,
			topic: "\x1b]0;x\x07backup",
			questions: [{ id: "Q1", title: "ok" }, "garbage", null, { id: "Q2", title: "\x1b[31mRED" }],
			answers: [
				{ id: "Q1", kind: "accepted", label: "yes" },
				{ id: "Q9", kind: "hax", label: "poison" },
				{ id: "Q2", kind: "choice", choiceIndex: 1.5, label: "x" },
				{ id: "Q3", kind: "choice", choiceIndex: 2, label: "\x1b[31mRED y" },
			],
			revised: "yes-not-boolean",
		});
		expect(rec).not.toBeNull();
		expect(rec!.round).toBe(2);
		expect(rec!.topic).toBe("backup");
		expect(rec!.questions).toHaveLength(2);
		expect(rec!.answers).toHaveLength(2);
		expect(rec!.answers[1].label).toBe("RED y");
		expect(rec!.revised).toBeUndefined();
	});

	it("keeps a boolean revised flag", () => {
		const rec = parseRoundRecord({ round: 1, questions: [], answers: [], revised: true });
		expect(rec?.revised).toBe(true);
	});
});

describe("answersToText — prompt contract", () => {
	const questions: Parameters<typeof answersToText>[1] = [
		{ id: "Q1", title: "Cadence" },
		{ id: "Q2", title: "Sign-off" },
		{ id: "Q3", title: "Rollback" },
	];

	it("renders every answer kind in its fixed format", () => {
		const text = answersToText(3, questions, [
			{ id: "Q1", kind: "accepted", label: "Deploy on merge" },
			{ id: "Q2", kind: "choice", label: "The captain", choiceIndex: 2 },
			{ id: "Q3", kind: "custom", label: "manual drills" },
		]);
		expect(text).toContain("Grill deck round 3 answers:");
		expect(text).toContain('Q1 (Cadence): accepted your recommendation — "Deploy on merge"');
		expect(text).toContain("Q2 (Sign-off): chose option 2 — \"The captain\"");
		expect(text).toContain('Q3 (Rollback): user wrote — "manual drills"');
	});

	it("marks deferred answers as still-open for the design tree", () => {
		const text = answersToText(1, questions, [{ id: "Q1", kind: "deferred", label: "deferred by user" }]);
		expect(text).toContain("DEFERRED — user wants to decide later; treat as still open");
		expect(text).toContain("Deferred questions remain open in the design tree.");
	});

	it("handles answers without a matching question", () => {
		const text = answersToText(1, [], [{ id: "QX", kind: "custom", label: "orphan" }]);
		expect(text).toContain("QX: user wrote — \"orphan\"");
	});
});

describe("limits and guards", () => {
	it("keeps the documented deck limits", () => {
		expect(MAX_QUESTIONS).toBe(32);
		expect(MAX_FIELD_LENGTH).toBe(2000);
	});

	it("isPlainObject excludes arrays and null", () => {
		expect(isPlainObject({})).toBe(true);
		expect(isPlainObject([])).toBe(false);
		expect(isPlainObject(null)).toBe(false);
		expect(isPlainObject("x")).toBe(false);
	});
});
