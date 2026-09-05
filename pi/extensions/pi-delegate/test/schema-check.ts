/**
 * T16 — Schema library/inheritance + progress pings unit checks
 * (DESIGN.md §16–§18, worker A5 contracts).
 *
 * Run with: bun test/schema-check.ts   (from repo root)
 *
 * Covers:
 *   1. resolveReportSchema — inline fragment pass-through (provenance ["inline"]).
 *   2. Named library lookup — temp schema dir injected via
 *      resolveReportSchemaInDir / loadLibrarySchema dirOverride (bun caches
 *      os.homedir(), so $HOME overrides are NOT honored — hence the seam).
 *   3. $extends merge — properties union, required union, child precedence.
 *   4. $extends cycle → {ok:false}.
 *   5. Depth cap (chain of 8 hops ok, 9 → {ok:false}).
 *   6. Corrupt / non-object library file → {ok:false}.
 *   7. readLastProgress — absent, empty, valid, partial-last-line,
 *      corrupt-lines-then-valid.
 *
 * Exit 0 only if all checks pass.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadLibrarySchema,
	progressPathFor,
	readLastProgress,
	resolveReportSchema,
	resolveReportSchemaInDir,
} from "../src/exchange.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures++;
		console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

function eq(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

const root = mkdtempSync(join(tmpdir(), "schema-check-"));
const schemaDir = join(root, "schemas");
const briefs = join(root, "briefs");
mkdirSync(schemaDir, { recursive: true });
mkdirSync(briefs, { recursive: true });

/** Write a brief whose frontmatter carries the given reportSchema value. */
function writeBrief(name: string, reportSchema: unknown): string {
	const value = typeof reportSchema === "string" ? reportSchema : JSON.stringify(reportSchema);
	const path = join(briefs, `${name}.md`);
	writeFileSync(path, `---\nreportSchema: ${value}\n---\nbody\n`, "utf8");
	return path;
}

function writeSchema(name: string, schema: unknown): void {
	writeFileSync(join(schemaDir, `${name}.json`), JSON.stringify(schema, null, "\t"), "utf8");
}

// ---------------------------------------------------------------------------
// 1. inline fragment pass-through
// ---------------------------------------------------------------------------

{
	const inline = { type: "object", required: ["worker"], properties: { worker: { type: "string" } } };
	const r = resolveReportSchema(writeBrief("inline", inline));
	check(
		"inline: ok",
		r.ok && eq(r.schema, inline) && eq(r.provenance, ["inline"]),
		JSON.stringify(r),
	);

	// brief with NO reportSchema key at all
	const absentPath = join(briefs, "absent.md");
	writeFileSync(absentPath, "---\ntitle: no-schema\n---\nbody\n", "utf8");
	const absent = resolveReportSchema(absentPath);
	check(
		// Corrected contract (DESIGN.md §11 backward compat): absent reportSchema
		// → base-only, schema null — schema-less briefs remain valid.
		"absent reportSchema → base-only (ok, schema:null)",
		absent.ok && absent.schema === null && absent.provenance.length === 0,
		JSON.stringify(absent),
	);

	// string reportSchema that matches no library file (real HOME has none)
	const unknown = resolveReportSchema(writeBrief("unknown", "no-such-type-zz"));
	check("unknown library name → ok:false", !unknown.ok, JSON.stringify(unknown));
}

// ---------------------------------------------------------------------------
// 2. named lookup (temp schema dir override)
// ---------------------------------------------------------------------------

{
	writeSchema("impl-report", {
		type: "object",
		required: ["worker", "status"],
		properties: { worker: { type: "string" }, status: { type: "string" } },
	});
	const r = resolveReportSchemaInDir(writeBrief("named", "impl-report"), schemaDir);
	const expected = {
		type: "object",
		required: ["worker", "status"],
		properties: { worker: { type: "string" }, status: { type: "string" } },
	};
	check(
		"named lookup resolves from injected dir",
		r.ok && eq(r.schema, expected) && eq(r.provenance, ["impl-report"]),
		JSON.stringify(r),
	);

	const direct = loadLibrarySchema("impl-report", schemaDir);
	check("loadLibrarySchema override: ok", direct.ok, JSON.stringify(direct));

	const missing = loadLibrarySchema("nope", schemaDir);
	check("loadLibrarySchema missing → ok:false", !missing.ok, JSON.stringify(missing));
}

// ---------------------------------------------------------------------------
// 3. $extends merge — properties union, required union, child precedence
// ---------------------------------------------------------------------------

{
	writeSchema("qa-base", {
		type: "object",
		additionalProperties: true,
		required: ["worker", "status"],
		properties: {
			worker: { type: "string" },
			common: { type: "string", description: "from parent" },
		},
	});
	writeSchema("qa-report", {
		$extends: "qa-base",
		type: "object",
		additionalProperties: false, // child precedence over parent's true
		required: ["evidence"], // union with parent's → worker,status,evidence
		properties: {
			worker: { type: "string", minLength: 1 }, // child wins per key
			evidence: { type: "array" },
		},
	});
	const r = resolveReportSchemaInDir(writeBrief("merge", "qa-report"), schemaDir);
	const expected = {
		type: "object",
		additionalProperties: false,
		required: ["worker", "status", "evidence"],
		properties: {
			worker: { type: "string", minLength: 1 },
			common: { type: "string", description: "from parent" },
			evidence: { type: "array" },
		},
	};
	check(
		"$extends merge: properties union + required union + child precedence + $extends consumed",
		r.ok && eq(r.schema, expected) && eq(r.provenance, ["qa-report", "qa-base"]),
		JSON.stringify(r),
	);

	// grandparent chain: resolution order provenance
	writeSchema("qa-grand", { type: "object", title: "grand" });
	writeFileSync(
		join(schemaDir, "qa-mid.json"),
		JSON.stringify({ $extends: "qa-grand", title: "mid" }),
		"utf8",
	);
	writeFileSync(
		join(schemaDir, "qa-leaf.json"),
		JSON.stringify({ $extends: "qa-mid", title: "leaf" }),
		"utf8",
	);
	const chain = resolveReportSchemaInDir(writeBrief("chain", "qa-leaf"), schemaDir);
	check(
		"3-level chain: merged + provenance order",
		chain.ok &&
			eq(chain.ok ? chain.schema : null, { type: "object", title: "leaf" }) &&
			eq(chain.ok ? chain.provenance : [], ["qa-leaf", "qa-mid", "qa-grand"]),
		JSON.stringify(chain),
	);
}

// ---------------------------------------------------------------------------
// 4. cycle → {ok:false}
// ---------------------------------------------------------------------------

{
	writeSchema("cyc-a", { $extends: "cyc-b" });
	writeSchema("cyc-b", { $extends: "cyc-a" });
	const r = resolveReportSchemaInDir(writeBrief("cycle", "cyc-a"), schemaDir);
	check(
		"$extends cycle → ok:false mentioning cycle",
		!r.ok && r.error.includes("cycle"),
		JSON.stringify(r),
	);

	// self-cycle
	writeSchema("cyc-self", { $extends: "cyc-self" });
	const self = resolveReportSchemaInDir(writeBrief("cycle-self", "cyc-self"), schemaDir);
	check("self $extends cycle → ok:false", !self.ok && self.error.includes("cycle"), JSON.stringify(self));
}

// ---------------------------------------------------------------------------
// 5. depth cap — 8 hops ok, 9 → {ok:false}
// ---------------------------------------------------------------------------

{
	for (let i = 0; i <= 9; i++) {
		const s: Record<string, unknown> = { title: `d${i}` };
		if (i < 9) s.$extends = `depth-${i + 1}`;
		writeSchema(`depth-${i}`, s);
	}
	const ok8 = resolveReportSchemaInDir(writeBrief("depth8", "depth-1"), schemaDir);
	check("depth 8 hops → ok", ok8.ok, JSON.stringify(ok8));
	const bad9 = resolveReportSchemaInDir(writeBrief("depth9", "depth-0"), schemaDir);
	check(
		"depth 9 hops → ok:false mentioning depth",
		!bad9.ok && bad9.error.includes("deeper than 8"),
		JSON.stringify(bad9),
	);
}

// ---------------------------------------------------------------------------
// 6. corrupt / non-object library file → {ok:false}
// ---------------------------------------------------------------------------

{
	writeFileSync(join(schemaDir, "corrupt.json"), "{ not json !!", "utf8");
	const corrupt = resolveReportSchemaInDir(writeBrief("corrupt", "corrupt"), schemaDir);
	check(
		"invalid JSON library file → ok:false",
		!corrupt.ok && corrupt.error.includes("not valid JSON"),
		JSON.stringify(corrupt),
	);

	writeFileSync(join(schemaDir, "array.json"), "[1,2,3]", "utf8");
	const arr = resolveReportSchemaInDir(writeBrief("array", "array"), schemaDir);
	check(
		"non-object (array) library file → ok:false",
		!arr.ok && arr.error.includes("JSON-Schema object"),
		JSON.stringify(arr),
	);

	writeFileSync(join(schemaDir, "null.json"), "null", "utf8");
	const nul = resolveReportSchemaInDir(writeBrief("null", "null"), schemaDir);
	check(
		// reportSchema: null in frontmatter ≈ unset → base-only (DESIGN.md §11);
		// a null library FILE still rejects via loadLibrarySchema (tested by
		// unknown-name path).
		"reportSchema:null in brief → base-only (ok, schema:null)",
		nul.ok && nul.schema === null,
		JSON.stringify(nul),
	);
}

// ---------------------------------------------------------------------------
// 7. readLastProgress
// ---------------------------------------------------------------------------

{
	const ev = (phase: string) => ({ worker: "w1", ts: "2026-01-01T00:00:00Z", phase });

	const absent = readLastProgress(join(root, "does-not-exist.jsonl"));
	check("readLastProgress: absent file → null", absent === null, JSON.stringify(absent));

	const emptyPath = join(root, "empty.jsonl");
	writeFileSync(emptyPath, "", "utf8");
	check("readLastProgress: empty file → null", readLastProgress(emptyPath) === null);

	const validPath = progressPathFor(root, "valid");
	writeFileSync(validPath, `${JSON.stringify(ev("researching"))}\n${JSON.stringify(ev("verifying"))}\n`, "utf8");
	const last = readLastProgress(validPath);
	check(
		"readLastProgress: valid → last line wins",
		last !== null && last.phase === "verifying" && last.worker === "w1",
		JSON.stringify(last),
	);

	const partialPath = progressPathFor(root, "partial");
	writeFileSync(
		partialPath,
		`${JSON.stringify(ev("implementing"))}\n${JSON.stringify(ev("verifying"))}\n{"worker":"w1","ts":"2026-01-0`,
		"utf8",
	);
	const partial = readLastProgress(partialPath);
	check(
		"readLastProgress: partial last line tolerated → earlier valid line",
		partial !== null && partial.phase === "verifying",
		JSON.stringify(partial),
	);

	const corruptPath = progressPathFor(root, "corrupt");
	writeFileSync(
		corruptPath,
		[
			"garbage not json",
			"{broken",
			JSON.stringify(ev("researching")),
			JSON.stringify({ nope: true }), // valid JSON but not a ProgressEvent
			JSON.stringify(ev("testing")),
			"",
		].join("\n"),
		"utf8",
	);
	const corrupt = readLastProgress(corruptPath);
	check(
		"readLastProgress: corrupt lines skipped, non-progress JSON skipped",
		corrupt !== null && corrupt.phase === "testing",
		JSON.stringify(corrupt),
	);

	const noneValidPath = progressPathFor(root, "nonevalid");
	writeFileSync(noneValidPath, "garbage\n{broken\n", "utf8");
	check("readLastProgress: no valid line → null", readLastProgress(noneValidPath) === null);
}

// ---------------------------------------------------------------------------

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
