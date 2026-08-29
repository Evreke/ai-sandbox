/**
 * grill-deck — an interactive question deck for grilling-style interviews.
 *
 * Instead of dumping a frontier of questions as markdown and hoping the user's
 * free-text reply maps back correctly, the model calls the `grill_deck` tool
 * with ALL questions of the current round. The user answers them in one TUI:
 *
 *   ↑↓ move between questions
 *   Enter      expand focused question into its options
 *   a          accept the recommendation (quick path)
 *   A          accept ALL recommendations at once
 *   e          write a custom answer
 *   s          defer — keep the question open for a later round
 *   ctrl+s     submit the round (every question answered or deferred)
 *   Esc        cancel the deck
 *
 * The tool returns structured answers to the model, so there is no parsing of
 * free text and deferred questions stay explicitly open in the design tree.
 *
 * State: each submitted round is persisted as a session entry
 * ("grill-deck-round", revisions as "grill-deck-revision"), rebuilt on
 * session_start. A widget above the editor shows live progress, and
 * `/grill` reopens the last deck to review/revise answers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------- types

interface DeckQuestion {
	id: string;
	title: string;
	body?: string;
	choices?: string[];
	recommendation?: string;
}

type AnswerKind = "accepted" | "choice" | "custom" | "deferred";

interface DeckAnswer {
	id: string;
	kind: AnswerKind;
	label: string;
	choiceIndex?: number;
}

interface DeckOutcome {
	cancelled: boolean;
	answers: DeckAnswer[];
}

interface RoundRecord {
	round: number;
	topic?: string;
	questions: DeckQuestion[];
	answers: DeckAnswer[];
	revised?: boolean;
}

// ---------------------------------------------------------------- state

const rounds: RoundRecord[] = [];

// ---------------------------------------------------------------- schema

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Stable short identifier, e.g. 'Q1' or 'merge-policy'" }),
	title: Type.String({ description: "One-line question title shown in the deck list" }),
	body: Type.Optional(Type.String({ description: "Longer question body/context shown under the focused question" })),
	choices: Type.Optional(Type.Array(Type.String(), { description: "Concrete answer options the user can pick from (do not repeat the recommendation here unless it is genuinely one of the options)" })),
	recommendation: Type.Optional(Type.String({ description: "Your recommended answer for this question" })),
});

const GrillDeckParams = Type.Object({
	topic: Type.Optional(Type.String({ description: "Short topic label for the deck header, e.g. 'PR review format'" })),
	questions: Type.Array(QuestionSchema, {
		description:
			"ALL questions of this round — the whole frontier you can ask right now without guessing at unanswered prerequisites. Do not split a round into multiple calls.",
	}),
});

// ---------------------------------------------------------------- helpers

function truncatePlain(s: string, max: number): string {
	return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + "…";
}

function updateWidget(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") return;
	if (rounds.length === 0) {
		ctx.ui.setWidget("grill-deck", undefined);
		return;
	}
	const all = rounds.flatMap((r) => r.answers);
	const deferred = all.filter((a) => a.kind === "deferred");
	const settled = all.length - deferred.length;
	const last = rounds[rounds.length - 1];
	const line =
		`⚑ grill: ${rounds.length} round${rounds.length === 1 ? "" : "s"}` +
		` · settled ${settled}` +
		` · deferred ${deferred.length}` +
		(deferred.length > 0 ? ` (${deferred.map((a) => a.id).join(", ")})` : "") +
		` · last R${last.round}: ${last.topic ?? "untitled"} · /grill to review`;
	ctx.ui.setWidget("grill-deck", [line]);
}

function answersToText(round: number, questions: DeckQuestion[], answers: DeckAnswer[]): string {
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

// ---------------------------------------------------------------- deck UI

interface DeckHandle {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
}

function openDeck(
	ctx: { ui: ExtensionContext["ui"]; mode: string },
	questions: DeckQuestion[],
	prefill?: DeckAnswer[],
): Promise<DeckOutcome | null> {
	if (ctx.mode !== "tui") return Promise.resolve(null);

	return ctx.ui.custom<DeckOutcome>((tui, theme, _kb, done) => {
		const answers = new Map<string, DeckAnswer>((prefill ?? []).map((a) => [a.id, a]));
		let mode: "list" | "expand" | "input" = "list";
		let cursor = 0;
		let optCursor = 0;
		let statusMsg = "";
		let cachedLines: string[] | undefined;
		let inputQuestionId: string | null = null;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);
		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (trimmed) {
				answers.set(inputQuestionId, { id: inputQuestionId, kind: "custom", label: trimmed });
			}
			inputQuestionId = null;
			editor.setText("");
			mode = "list";
			advance();
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function currentQ(): DeckQuestion | undefined {
			return questions[cursor];
		}

		function optionsFor(q: DeckQuestion): { kind: AnswerKind; label: string; choiceIndex?: number }[] {
			const opts: { kind: AnswerKind; label: string; choiceIndex?: number }[] = [];
			if (q.recommendation) opts.push({ kind: "accepted", label: `★ Accept recommendation: ${q.recommendation}` });
			(q.choices ?? []).forEach((c, i) => opts.push({ kind: "choice", label: c, choiceIndex: i + 1 }));
			opts.push({ kind: "custom", label: "✎ Write a custom answer" });
			opts.push({ kind: "deferred", label: "⤳ Defer — keep open for a later round" });
			return opts;
		}

		function advance() {
			const next = questions.findIndex((q, i) => i > cursor && !answers.has(q.id));
			if (next >= 0) {
				cursor = next;
				return;
			}
			const firstOpen = questions.findIndex((q) => !answers.has(q.id));
			cursor = firstOpen >= 0 ? firstOpen : Math.min(cursor, questions.length - 1);
		}

		function optionIndexForCurrentAnswer(q: DeckQuestion): number {
			const ans = answers.get(q.id);
			if (!ans) return 0;
			const idx = optionsFor(q).findIndex((o) =>
				ans.kind === "choice"
					? o.kind === "choice" && o.choiceIndex === ans.choiceIndex
					: o.kind === ans.kind,
			);
			return idx >= 0 ? idx : 0;
		}

		function commitOption(q: DeckQuestion, opt: { kind: AnswerKind; label: string; choiceIndex?: number }) {
			if (opt.kind === "custom") {
				mode = "input";
				inputQuestionId = q.id;
				editor.setText("");
				refresh();
				return;
			}
			answers.set(q.id, {
				id: q.id,
				kind: opt.kind,
				label: opt.kind === "accepted" ? (q.recommendation ?? opt.label) : opt.label,
				choiceIndex: opt.choiceIndex,
			});
			mode = "list";
			advance();
			refresh();
		}

		function acceptOne(q: DeckQuestion) {
			if (!q.recommendation) {
				statusMsg = `${q.id} has no recommendation — press Enter to browse its options`;
				refresh();
				return;
			}
			answers.set(q.id, { id: q.id, kind: "accepted", label: q.recommendation });
			statusMsg = "";
			advance();
			refresh();
		}

		function acceptAll() {
			let n = 0;
			for (const q of questions) {
				if (q.recommendation && !answers.has(q.id)) {
					answers.set(q.id, { id: q.id, kind: "accepted", label: q.recommendation });
					n++;
				}
			}
			statusMsg = n > 0 ? `Accepted ${n} recommendation${n === 1 ? "" : "s"}` : "Nothing new to accept";
			refresh();
		}

		function unanswered(): DeckQuestion[] {
			return questions.filter((q) => !answers.has(q.id));
		}

		function submit() {
			const open = unanswered();
			if (open.length > 0) {
				statusMsg = `${open.length} unanswered: ${open.map((q) => q.id).join(", ")} — answer or defer (s) first`;
				refresh();
				return;
			}
			done({ cancelled: false, answers: questions.map((q) => answers.get(q.id)!) });
		}

		function handleInput(data: string) {
			// Input mode: route to the embedded editor
			if (mode === "input") {
				if (matchesKey(data, Key.escape)) {
					mode = "list";
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			// Expand mode: pick an option for the focused question
			if (mode === "expand") {
				const q = currentQ();
				if (!q) {
					mode = "list";
					refresh();
					return;
				}
				const opts = optionsFor(q);
				if (matchesKey(data, Key.escape)) {
					mode = "list";
					refresh();
					return;
				}
				if (matchesKey(data, Key.up)) {
					optCursor = Math.max(0, optCursor - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					optCursor = Math.min(opts.length - 1, optCursor + 1);
					refresh();
					return;
				}
				if (/^[1-9]$/.test(data)) {
					const idx = Number(data) - 1;
					if (idx < opts.length) {
						commitOption(q, opts[idx]);
						return;
					}
				}
				if (matchesKey(data, Key.enter)) {
					commitOption(q, opts[optCursor]);
					return;
				}
				return;
			}

			// List mode: browse questions
			if (matchesKey(data, Key.up)) {
				cursor = Math.max(0, cursor - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				cursor = Math.min(questions.length - 1, cursor + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const q = currentQ();
				if (!q) return;
				if (q.recommendation && !answers.has(q.id)) {
					// Dominant action: Enter accepts the recommendation outright.
					acceptOne(q);
				} else {
					// No recommendation (or revisiting an answered question):
					// open the options view, pre-highlighting the current answer.
					mode = "expand";
					optCursor = optionIndexForCurrentAnswer(q);
					refresh();
				}
				return;
			}
			if (data === " " || data === "o") {
				const q = currentQ();
				if (!q) return;
				mode = "expand";
				optCursor = optionIndexForCurrentAnswer(q);
				refresh();
				return;
			}
			if (data === "a") {
				const q = currentQ();
				if (q) acceptOne(q);
				return;
			}
			if (data === "A") {
				acceptAll();
				return;
			}
			if (data === "e") {
				const q = currentQ();
				if (q) {
					const existing = answers.get(q.id);
					mode = "input";
					inputQuestionId = q.id;
					editor.setText(existing?.kind === "custom" ? existing.label : "");
					refresh();
				}
				return;
			}
			if (data === "s") {
				const q = currentQ();
				if (q) {
					answers.set(q.id, { id: q.id, kind: "deferred", label: "deferred by user" });
					statusMsg = "";
					advance();
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.ctrl("s"))) {
				submit();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ cancelled: true, answers: [] });
				return;
			}
		}

		function addWrappedWithPrefix(
			lines: string[],
			prefix: string,
			text: string,
			width: number,
		) {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= width) {
				lines.push(...wrapTextWithAnsi(prefix + text, width));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, width - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			for (let i = 0; i < wrapped.length; i++) {
				lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const w = Math.max(20, width);
			const lines: string[] = [];
			const answeredCount = questions.length - unanswered().length;

			lines.push(theme.fg("accent", "─".repeat(w)));
			lines.push(
				theme.fg("accent", theme.bold(` grill deck · ${questions.length} questions · ${answeredCount} answered `)),
			);
			lines.push(theme.fg("accent", "─".repeat(w)));

			if (mode === "expand") {
				const q = currentQ()!;
				addWrappedWithPrefix(lines, theme.fg("accent", "> "), theme.bold(`${q.id} ${q.title}`), w);
				if (q.body) addWrappedWithPrefix(lines, "    ", theme.fg("dim", q.body), w);
				lines.push("");
				const opts = optionsFor(q);
				opts.forEach((o, i) => {
					const sel = i === optCursor;
					const prefix = sel ? theme.fg("accent", "> ") : "  ";
					const label = `${i + 1}. ${o.label}`;
					addWrappedWithPrefix(lines, prefix, sel ? theme.fg("accent", label) : label, w);
				});
			} else {
				questions.forEach((q, i) => {
					const focused = i === cursor;
					const ans = answers.get(q.id);
					const mark = ans
						? ans.kind === "deferred"
							? theme.fg("warning", "⤳")
							: theme.fg("success", "✓")
						: theme.fg("dim", "·");
					const prefix = focused ? theme.fg("accent", "> ") : "  ";
					const title = `${q.id} ${q.title}`;
					addWrappedWithPrefix(lines, prefix + mark + " ", focused ? theme.bold(title) : title, w);
					if (focused) {
						if (q.body) addWrappedWithPrefix(lines, "      ", theme.fg("dim", q.body), w);
						if (q.recommendation) {
							addWrappedWithPrefix(lines, "      ", theme.fg("muted", `➡️ rec: ${q.recommendation}`), w);
						}
						if (ans && ans.kind !== "deferred") {
							addWrappedWithPrefix(lines, "      ", theme.fg("success", `your answer: ${ans.label}`), w);
						}
						if (mode === "input") {
							if (q.choices?.length) {
								lines.push("");
								for (const c of q.choices) {
									addWrappedWithPrefix(lines, "        ", theme.fg("dim", `- ${truncatePlain(c, Math.max(10, w - 12))}`), w);
								}
							}
							lines.push("");
							addWrappedWithPrefix(lines, "      ", theme.fg("text", "your answer (Enter to save, Esc to cancel):"), w);
							for (const l of editor.render(Math.max(1, w - 8))) {
								lines.push(`      ${l}`);
							}
						}
					} else if (ans) {
						const label = ans.kind === "deferred" ? theme.fg("warning", "deferred") : theme.fg("dim", truncatePlain(ans.label, Math.max(10, w - 10)));
						addWrappedWithPrefix(lines, "        ", label, w);
					}
				});
			}

			if (statusMsg) {
				lines.push("");
				addWrappedWithPrefix(lines, " ", theme.fg("warning", statusMsg), w);
			}

			lines.push("");
			const help =
				mode === "expand"
					? "↑↓ or 1-9 option · Enter select · Esc back"
					: mode === "input"
						? "Enter save answer · Esc back"
						: "↑↓ move · Enter accept rec · Space options · A accept all · e write · s defer · ctrl+s submit · Esc cancel";
			addWrappedWithPrefix(lines, " ", theme.fg("dim", help), w);
			lines.push(theme.fg("accent", "─".repeat(w)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

// ---------------------------------------------------------------- extension

export default function grillDeck(pi: ExtensionAPI) {
	function replayFromSession(ctx: ExtensionContext) {
		rounds.length = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "grill-deck-round") {
				const d = entry.data as RoundRecord;
				if (d && Array.isArray(d.questions)) rounds.push({ ...d });
			} else if (entry.customType === "grill-deck-revision") {
				const d = entry.data as { round: number; answers: DeckAnswer[] };
				const rec = rounds.find((r) => r.round === d.round);
				if (rec && Array.isArray(d.answers)) rec.answers = d.answers;
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		replayFromSession(ctx);
		updateWidget(ctx);
	});

	pi.registerTool({
		name: "grill_deck",
		label: "Grill Deck",
		description:
			"Ask the user a batch of questions in one interactive deck (numbered list with per-question options, recommendation fast-accept, defer). Use this for grilling/interview sessions instead of printing questions as markdown: pass the entire frontier of the round — every question you can ask now — in a single call. The result contains the user's structured answers, including explicitly DEFERRED questions that stay open.",
		promptSnippet: "Present a round of interview/grilling questions as an interactive deck and get structured answers",
		promptGuidelines: [
			"Use grill_deck when stress-testing a plan or interviewing the user: put ALL currently askable questions (the whole frontier) into one call, each with a short title, optional body, optional choices, and your recommended answer. After receiving answers, recompute the frontier and call grill_deck again for the next round; treat DEFERRED answers as still-open.",
		],
		parameters: GrillDeckParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = (params.questions ?? []).map((q, i) => ({
				id: q.id || `Q${i + 1}`,
				title: q.title,
				body: q.body,
				choices: q.choices,
				recommendation: q.recommendation,
			}));

			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "grill_deck needs an interactive terminal. Print the questions as a markdown list instead: one '❓ Qn - title: body' block per question with a '➡️ recommendation' line.",
						},
					],
					details: { cancelled: true },
				};
			}
			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "No questions provided." }],
					details: { cancelled: true },
				};
			}

			const outcome = await openDeck(ctx, questions);
			if (!outcome) {
				return {
					content: [{ type: "text", text: "UI unavailable." }],
					details: { cancelled: true },
				};
			}

			if (outcome.cancelled) {
				return {
					content: [
						{
							type: "text",
							text: "User cancelled the question deck. Do not immediately re-ask the same questions; continue in plain text or ask what to change.",
						},
					],
					details: { cancelled: true },
				};
			}

			const round = rounds.length + 1;
			const record: RoundRecord = {
				round,
				topic: params.topic,
				questions,
				answers: outcome.answers,
			};
			rounds.push(record);
			pi.appendEntry("grill-deck-round", record);
			updateWidget(ctx);

			return {
				content: [{ type: "text", text: answersToText(round, questions, outcome.answers) }],
				details: { round, answers: outcome.answers },
			};
		},

		renderCall(args, theme, _context) {
			const qs = ((args as { questions?: DeckQuestion[] } | undefined)?.questions ?? []) as DeckQuestion[];
			const topic = (args as { topic?: string } | undefined)?.topic;
			let text = theme.fg("toolTitle", theme.bold("grill_deck "));
			text += theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
			if (topic) text += theme.fg("dim", ` — ${topic}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as { round?: number; answers?: DeckAnswer[]; cancelled?: boolean } | undefined;
			if (!details || details.cancelled) {
				const first = result.content[0];
				return new Text(theme.fg("warning", first && first.type === "text" ? "cancelled" : ""), 0, 0);
			}
			const lines = (details.answers ?? []).map((a) => {
				const mark = a.kind === "deferred" ? theme.fg("warning", "⤳") : theme.fg("success", "✓");
				const label = a.kind === "deferred" ? "deferred" : truncatePlain(a.label, 80);
				return `${mark} ${a.id}: ${label}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerCommand("grill", {
		description: "Reopen the last grill deck to review or revise answers",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("grill requires interactive mode", "error");
				return;
			}
			const last = rounds[rounds.length - 1];
			if (!last) {
				ctx.ui.notify("No grill deck rounds yet — ask the agent to grill you", "info");
				return;
			}
			const before = JSON.stringify(last.answers);
			const outcome = await openDeck(ctx, last.questions, last.answers);
			if (!outcome || outcome.cancelled) {
				ctx.ui.notify("Deck closed without changes", "info");
				return;
			}
			if (JSON.stringify(outcome.answers) === before) {
				ctx.ui.notify("No changes", "info");
				return;
			}
			last.answers = outcome.answers;
			last.revised = true;
			pi.appendEntry("grill-deck-revision", { round: last.round, answers: last.answers });
			updateWidget(ctx);
			pi.sendUserMessage(
				`Revised answers for grill deck round ${last.round}:\n${answersToText(last.round, last.questions, last.answers)}`,
			);
		},
	});
}
