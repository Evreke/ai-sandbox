/**
 * Windows-path contract checks for the exchange layer (design-windows-mailbox.md
 * §3.2 — the single path-builder rule). No Windows host needed: every check
 * feeds synthetic Windows-shaped strings through the builders with the
 * INJECTED platform (node:path.win32) — pure string asserts, valid on any OS.
 *
 * Run with: bun test/expaths-check.ts   (from extensions/pi-delegate)
 *
 * Checks:
 *   W1  Builders (report/q/a/nudge-failed/release/progress/manifest/probe/
 *       question-archive) emit separator-native output for the injected
 *       platform: backslash paths for win32 fixtures, byte-identical
 *       `${dir}/…` template-literal output for the default (posix) platform.
 *   W2  taskSlug: `C:\tmp\exchange\task` → "task" (the old dir.split("/")
 *       returned the whole drive-letter string); UNC + long-path round-trips.
 *   W3  isProbeDir accepts backslash probe dirs (`C:\…\_probe`) and still
 *       classifies posix `…/_probe`; rejects lookalikes (`…/probe-x`).
 *   W4  ensureExchangeDir with the injected win32 platform: a brief parent
 *       that differs from the exchange root only by drive-letter/component
 *       CASE (`c:\…` vs `C:\…`) passes the root-membership compare (the old
 *       raw string compare failed E_BRIEF spuriously); a matching-case brief
 *       validates end-to-end; a genuinely foreign parent still fails.
 *   W5  sameDir/normalizeDirKey/isDirUnder: win32 case+separator folding;
 *       posix strict equality; boundary-aware containment (a sibling with a
 *       shared prefix — `…/worktrees-extra` — is NOT under `…/worktrees`).
 *   W6  exchangeRoot precedence: env override beats the per-OS default; the
 *       win32 default is %LOCALAPPDATA%\pi\exchange (HOME-independent); the
 *       posix default stays byte-for-byte /tmp/exchange.
 *   W1.7 (TZ §3.7 "mixed input separators") builders fed MIXED `/`+`\`
 *       inputs on win32 emit fully normalized backslash paths; W1.8 posix
 *       byte-compat for the remaining builders (probe, question-archive);
 *       W2.5 taskSlug and W3.4 isProbeDir on mixed separators; W4.5
 *       ensureExchangeDir SUCCEEDS end-to-end when the brief parent differs
 *       from the root by drive-letter CASE (`c:\…` vs `C:\…`).
 *
 * Exit 0 only if all checks pass.
 */

import { rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as win32 from "node:path/win32";
import {
	answerPathFor as buildAnswerPath,
	isDirUnder,
	isProbeDir,
	manifestPathFor as buildManifestPath,
	nudgeFailedPathFor as buildNudgeFailedPath,
	probeDirPathFor as buildProbeDirPath,
	progressPathFor as buildProgressPath,
	questionArchivePathFor as buildQuestionArchivePath,
	questionPathFor as buildQuestionPath,
	releasePathFor as buildReleasePath,
	reportPathFor as buildReportPath,
	sameDir,
	taskSlug,
	normalizeDirKey,
} from "../src/expaths.ts";
import { ensureExchangeDir, exchangeRoot, isProbeDir as exchangeIsProbeDir } from "../src/exchange.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// W1 — builders with the injected win32 platform
// ---------------------------------------------------------------------------

const TASK = "C:\\tmp\\exchange\\task";
const NAME = "winfix";

check(
	"W1.1 win32 reportPathFor emits a backslash path",
	buildReportPath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\report-winfix.json",
	buildReportPath(TASK, NAME, win32),
);
check(
	"W1.2 win32 questionPathFor/answerPathFor emit backslash paths",
	buildQuestionPath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\q-winfix.json" &&
		buildAnswerPath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\a-winfix.json",
);
check(
	"W1.3 win32 nudge-failed/release/progress emit backslash paths",
	buildNudgeFailedPath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\nudge-failed-winfix.json" &&
		buildReleasePath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\release-winfix.json" &&
		buildProgressPath(TASK, NAME, win32) === "C:\\tmp\\exchange\\task\\p-winfix.jsonl",
);
check(
	"W1.4 win32 manifest/question-archive/probe builders emit backslash paths",
	buildManifestPath(TASK, win32) === "C:\\tmp\\exchange\\task\\manifest.json" &&
		buildQuestionArchivePath(TASK, NAME, 12345, win32) === "C:\\tmp\\exchange\\task\\q-winfix.answered-12345.json" &&
		buildProbeDirPath("C:\\tmp\\exchange", win32) === "C:\\tmp\\exchange\\_probe",
);
check(
	"W1.5 UNC and long-path inputs round-trip with no empty segments",
	(() => {
		const unc = buildReportPath("\\\\server\\share\\exchange\\task", NAME, win32);
		const long = buildReportPath("C:\\" + "nested\\".repeat(30) + "task", NAME, win32);
		const noEmpty = (s: string) => s.split("\\").slice(1).every((seg) => seg.length > 0);
		return unc === "\\\\server\\share\\exchange\\task\\report-winfix.json" &&
			noEmpty(long) &&
			long.endsWith("\\report-winfix.json");
	})(),
);
check(
	"W1.6 default platform (posix) is byte-identical to the old template literals",
	buildReportPath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/report-winfix.json" &&
		buildQuestionPath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/q-winfix.json" &&
		buildAnswerPath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/a-winfix.json" &&
		buildNudgeFailedPath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/nudge-failed-winfix.json" &&
		buildReleasePath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/release-winfix.json" &&
		buildProgressPath("/tmp/exchange/task", NAME) === "/tmp/exchange/task/p-winfix.jsonl" &&
		buildManifestPath("/tmp/exchange/task") === path.join("/tmp/exchange/task", "manifest.json"),
	buildManifestPath("/tmp/exchange/task"),
);
check(
	"W1.7 win32 builders normalize MIXED `/`+`\\` input separators (TZ §3.7) — no mixed-separator artifacts in the output",
	buildReportPath("C:/tmp/exchange/task", NAME, win32) === "C:\\tmp\\exchange\\task\\report-winfix.json" &&
		buildQuestionPath("C:\\tmp/exchange\\task", NAME, win32) === "C:\\tmp\\exchange\\task\\q-winfix.json" &&
		buildManifestPath("C:/tmp/exchange/task", win32) === "C:\\tmp\\exchange\\task\\manifest.json" &&
		buildProbeDirPath("C:/tmp/exchange", win32) === "C:\\tmp\\exchange\\_probe" &&
		buildQuestionArchivePath("C:/tmp/exchange/task", NAME, 12345, win32) ===
			"C:\\tmp\\exchange\\task\\q-winfix.answered-12345.json",
	buildReportPath("C:/tmp/exchange/task", NAME, win32),
);
check(
	"W1.8 default platform (posix): probe + question-archive builders stay byte-identical to the old template literals",
	buildProbeDirPath("/tmp/exchange") === "/tmp/exchange/_probe" &&
		buildQuestionArchivePath("/tmp/exchange/task", NAME, 12345) ===
			"/tmp/exchange/task/q-winfix.answered-12345.json",
	`${buildProbeDirPath("/tmp/exchange")} | ${buildQuestionArchivePath("/tmp/exchange/task", NAME, 12345)}`,
);

// ---------------------------------------------------------------------------
// W2 — taskSlug (fleet grouping key derivation)
// ---------------------------------------------------------------------------

check(
	"W2.1 win32 drive-letter dir slugs to its basename",
	taskSlug("C:\\tmp\\exchange\\task", win32) === "task",
	taskSlug("C:\\tmp\\exchange\\task", win32),
);
check(
	"W2.2 win32 UNC dir slugs to its basename",
	taskSlug("\\\\server\\share\\exchange\\task", win32) === "task",
);
check(
	"W2.3 posix slug parity with the old split-based rule",
	taskSlug("/tmp/exchange/task") === "task" && taskSlug("/tmp/exchange/") === "exchange",
);
check(
	"W2.4 bare roots fall back to the input (no empty slug)",
	taskSlug("/", win32) === "/" || taskSlug("/", win32) === "",
	`posixRoot="${taskSlug("/")}" win32Root="${taskSlug("C:\\", win32)}"`,
);
check(
	"W2.5 win32 slug on MIXED separators",
	taskSlug("C:/tmp/exchange/task", win32) === "task" && taskSlug("C:\\tmp/exchange\\task", win32) === "task",
	`${taskSlug("C:/tmp/exchange/task", win32)} | ${taskSlug("C:\\tmp/exchange\\task", win32)}`,
);

// ---------------------------------------------------------------------------
// W3 — probe-dir classification without separator assumptions
// ---------------------------------------------------------------------------

check(
	"W3.1 backslash probe dir is detected",
	isProbeDir("C:\\tmp\\exchange\\_probe", win32) && exchangeIsProbeDir("C:\\tmp\\exchange\\_probe", win32),
);
check(
	"W3.2 posix probe dir still detected (exchange.ts classifier delegates)",
	isProbeDir("/tmp/exchange/_probe") && exchangeIsProbeDir("/tmp/exchange/_probe"),
);
check(
	"W3.3 probe lookalikes rejected",
	!isProbeDir("C:\\tmp\\exchange\\probe-x", win32) &&
		!isProbeDir("/tmp/exchange/_probe-old") &&
		!isProbeDir("/tmp/exchange/task"),
);
check(
	"W3.4 probe classification on MIXED separators (win32 basename folds `/` and `\\`)",
	isProbeDir("C:/tmp/exchange/_probe", win32) && exchangeIsProbeDir("C:/tmp/exchange/_probe", win32) &&
		!isProbeDir("C:/tmp/exchange/_probe/old", win32),
);

// ---------------------------------------------------------------------------
// W4 — ensureExchangeDir root-membership compare (case/separator stability)
// ---------------------------------------------------------------------------

// Fixture: a REAL readable brief for the end-to-end case. On a posix host a
// win32-shaped "path" like "C:\tmp\…" is a SINGLE relative filename whose
// characters include backslashes (Linux has no drive letters) — so the
// fixture is exactly that one file in the process cwd. Cleaned up in finally.
const BRIEF_WIN32_REL = "C:\\tmp\\exchange\\task\\brief-winfix.md";
const previousRoot = process.env.PI_DELEGATE_EXCHANGE_ROOT;
let fixtureMade = false;
try {
	writeFileSync(
		BRIEF_WIN32_REL,
		"# Windows-path fixture\n\nDo the thing. OUTPUT: report-winfix.json\n",
	);
	fixtureMade = true;

	// W4.1 — matching case: full validation succeeds end-to-end (win32 platform).
	process.env.PI_DELEGATE_EXCHANGE_ROOT = "C:\\tmp\\exchange";
	try {
		const opened = ensureExchangeDir("C:\\tmp\\exchange\\task\\brief-winfix.md", win32);
		check(
			"W4.1 win32 brief with matching-case root validates end-to-end",
			opened.task === "task" &&
				opened.dir === "C:\\tmp\\exchange\\task" &&
				opened.reportPath === "C:\\tmp\\exchange\\task\\report-winfix.json",
			JSON.stringify(opened),
		);
	} catch (err) {
		check("W4.1 win32 brief with matching-case root validates end-to-end", false, (err as Error).message);
	}

	// W4.2 — case-variant root vs brief parent (`c:\…` vs `C:\…`): the root-
	// membership compare MUST pass (case-folded). The brief file itself is then
	// unreadable on this posix host under the lower-case spelling (Linux FS is
	// case-sensitive) — so the observable contract is: the failure is the FILE
	// read, never the "must live directly inside" root-membership rejection.
	process.env.PI_DELEGATE_EXCHANGE_ROOT = "C:\\tmp\\exchange";
	try {
		ensureExchangeDir("c:\\tmp\\exchange\\task\\brief-winfix.md", win32);
		check("W4.2 case-variant parent passes the root-membership compare", true);
	} catch (err) {
		const msg = (err as Error).message;
		check(
			"W4.2 case-variant parent passes the root-membership compare",
			!msg.includes("must live directly inside"),
			msg,
		);
	}

	// W4.5 — TZ §3.7: a brief parent differing from the root ONLY by
	// drive-letter CASE must SUCCEED end-to-end (not just dodge the membership
	// rejection like W4.2): a second fixture file under the lower-case `c:`
	// spelling is readable on this posix host (a distinct relative filename),
	// so the full validation — membership + read + report-path shape — runs.
	writeFileSync(
		"c:\\tmp\\exchange\\task\\brief-winfix-lc.md",
		"# Windows-path fixture (lower-case drive)\n\nDo the thing. OUTPUT: report-winfix-lc.json\n",
	);
	fixtureMade = true;
	process.env.PI_DELEGATE_EXCHANGE_ROOT = "C:\\tmp\\exchange";
	try {
		const opened = ensureExchangeDir("c:\\tmp\\exchange\\task\\brief-winfix-lc.md", win32);
		check(
			"W4.5 case-differing drive letter (brief `c:\\…` vs root `C:\\…`) validates END-TO-END on the win32 platform",
			opened.task === "task" &&
				opened.dir === "c:\\tmp\\exchange\\task" &&
				opened.reportPath === "c:\\tmp\\exchange\\task\\report-winfix-lc.json",
			JSON.stringify(opened),
		);
	} catch (err) {
		check(
			"W4.5 case-differing drive letter (brief `c:\\…` vs root `C:\\…`) validates END-TO-END on the win32 platform",
			false,
			(err as Error).message,
		);
	}

	// W4.3 — a genuinely foreign parent still fails E_BRIEF (no false accept).
	process.env.PI_DELEGATE_EXCHANGE_ROOT = "C:\\tmp\\exchange";
	try {
		ensureExchangeDir("C:\\elsewhere\\task\\brief-winfix.md", win32);
		check("W4.3 foreign parent still rejected", false, "no error thrown");
	} catch (err) {
		const msg = (err as Error).message;
		check("W4.3 foreign parent still rejected", msg.includes("must live directly inside"), msg);
	}

	// W4.4 — relative brief still rejected (platform-aware isAbsolute).
	process.env.PI_DELEGATE_EXCHANGE_ROOT = "C:\\tmp\\exchange";
	try {
		ensureExchangeDir("relative/brief.md", win32);
		check("W4.4 relative brief rejected under win32 platform", false, "no error thrown");
	} catch (err) {
		const msg = (err as Error).message;
		check("W4.4 relative brief rejected under win32 platform", msg.includes("must be absolute"), msg);
	}
} finally {
	if (previousRoot === undefined) delete process.env.PI_DELEGATE_EXCHANGE_ROOT;
	else process.env.PI_DELEGATE_EXCHANGE_ROOT = previousRoot;
	if (fixtureMade) {
		rmSync(BRIEF_WIN32_REL, { force: true });
		rmSync("c:\\tmp\\exchange\\task\\brief-winfix-lc.md", { force: true });
	}
}

// ---------------------------------------------------------------------------
// W5 — compare helpers
// ---------------------------------------------------------------------------

check(
	"W5.1 win32 keys fold case and both separators",
	normalizeDirKey("c:\\tmp\\Exchange\\task\\", win32) === normalizeDirKey("C:/tmp/exchange/task", win32),
);
check(
	"W5.2 posix keys stay byte-for-byte (case-sensitive FS)",
	normalizeDirKey("/tmp/Exchange", path) === "/tmp/Exchange" &&
		!sameDir("/tmp/exchange", "/tmp/Exchange", path),
);
check(
	"W5.3 win32 sameDir collapses case variants",
	sameDir("c:\\tmp\\exchange", "C:\\tmp\\exchange", win32) &&
		sameDir("C:/tmp/exchange/", "C:\\tmp\\exchange", win32),
);
check(
	"W5.4 containment is boundary-aware (posix parity with the old startsWith rule)",
	isDirUnder("/root/.herdr/worktrees/x", "/root/.herdr/worktrees", path) &&
		isDirUnder("/root/.herdr/worktrees", "/root/.herdr/worktrees", path) &&
		!isDirUnder("/root/.herdr/worktrees-extra", "/root/.herdr/worktrees", path),
);
check(
	"W5.5 containment accepts backslash children on the win32 shape",
	isDirUnder("C:\\Users\\x\\.herdr\\worktrees\\repo", "C:\\Users\\x\\.herdr\\worktrees", win32) &&
		isDirUnder("C:/Users/x/.herdr/worktrees/repo", "C:\\Users\\x\\.herdr\\worktrees", win32) &&
		!isDirUnder("C:\\Users\\x\\.herdr\\worktrees-extra", "C:\\Users\\x\\.herdr\\worktrees", win32),
);

// ---------------------------------------------------------------------------
// W6 — exchangeRoot precedence + per-OS default
// ---------------------------------------------------------------------------

check(
	"W6.1 posix default is byte-for-byte /tmp/exchange",
	exchangeRoot("linux") === "/tmp/exchange" && exchangeRoot("darwin") === "/tmp/exchange",
);
check(
	"W6.2 win32 default is %LOCALAPPDATA%\\pi\\exchange",
	(() => {
		const prev = process.env.LOCALAPPDATA;
		try {
			process.env.LOCALAPPDATA = "C:\\Users\\x\\AppData\\Local";
			return exchangeRoot("win32") === "C:\\Users\\x\\AppData\\Local\\pi\\exchange";
		} finally {
			if (prev === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = prev;
		}
	})(),
);
check(
	"W6.3 win32 default falls back to homedir-derived AppData\\Local",
	(() => {
		const prev = process.env.LOCALAPPDATA;
		try {
			delete process.env.LOCALAPPDATA;
			return exchangeRoot("win32").endsWith("\\AppData\\Local\\pi\\exchange");
		} finally {
			if (prev === undefined) delete process.env.LOCALAPPDATA;
			else process.env.LOCALAPPDATA = prev;
		}
	})(),
);
check(
	"W6.4 env override beats any per-OS default (and carries Windows values)",
	(() => {
		const prev = process.env.PI_DELEGATE_EXCHANGE_ROOT;
		try {
			process.env.PI_DELEGATE_EXCHANGE_ROOT = "D:\\exchange";
			return exchangeRoot("win32") === "D:\\exchange" && exchangeRoot("linux") === "D:\\exchange";
		} finally {
			if (prev === undefined) delete process.env.PI_DELEGATE_EXCHANGE_ROOT;
			else process.env.PI_DELEGATE_EXCHANGE_ROOT = prev;
		}
	})(),
);

// ---------------------------------------------------------------------------

if (failures > 0) {
	console.error(`\n${failures} WINDOWS-PATH CHECK(S) FAILED`);
	process.exit(1);
}
console.log("\nALL WINDOWS-PATH CHECKS PASSED");
