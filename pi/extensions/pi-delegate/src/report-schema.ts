/**
 * pi-delegate — src/report-schema.ts (Wave 3a: extracted from src/exchange.ts).
 *
 * MODULE_CONTRACT — strict report validation + brief-declared report
 * schemas.
 *
 * Purpose: the report contract enforcement — the v1 base-schema checks
 * (validateReport/baseValidate), the v1.2 brief-declared schema fragments
 * (parseBriefSchema + validateReportAgainstSchema via typebox Check/Errors)
 * and the v1.5 schema library with "$extends" inheritance resolution
 * (resolveReportSchema/resolveReportSchemaInDir, loadLibrarySchema,
 * mergeParentUnderChild, resolveExtendsChain).
 *
 * Dependencies: @earendil-works/pi-coding-agent (parseFrontmatter,
 * getAgentDir), typebox/value (Check/Errors — deep specifiers are BLOCKED by
 * typebox 1.3.7's exports map, see the note below), node builtins, ./host.ts
 * (WorkerReport type ONLY).
 *
 * EXTERNAL_DEPENDENCY: the user-level schema library dir under pi's
 * getAgentDir() (honors PI_CODING_AGENT_DIR) — resolved at module load into
 * USER_SCHEMA_DIR; project-level library dirs come in per call (two-tier
 * search, project first).
 *
 * Critical invariants: every validator returns {ok:false, error} instead of
 * throwing; error messages name the failing path.
 *
 * All bodies are byte-verbatim moves from src/exchange.ts (Wave 3a).
 */

import { parseFrontmatter, getAgentDir } from "@earendil-works/pi-coding-agent";
// typebox Value.Check/Errors — NOTE: the contract's deep specifiers
// ("typebox/build/value/check/check.mjs") are blocked by typebox 1.3.7's
// exports map (ERR_PACKAGE_PATH_NOT_EXPORTED, verified via node + jiti);
// "typebox/value" is the exported entry for the same build/value modules.
import { Check, Errors } from "typebox/value";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerReport } from "./host.ts";

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/**
 * Strict collect (DESIGN.md §6): file must exist, parse as JSON, and satisfy
 * the WorkerReport schema — worker === canonical name, status ∈ {pass, fail},
 * non-empty summary, artifacts/evidence arrays present.
 */
export function validateReport(
	path: string,
	canonicalName: string,
): { ok: true; report: WorkerReport } | { ok: false; error: string } {
	const base = baseValidate(path, canonicalName);
	if (!base.ok) return base;
	return { ok: true, report: reportOf(base.r) };
}

function reportOf(r: Record<string, unknown>): WorkerReport {
	return {
		worker: r.worker as string,
		status: r.status as WorkerReport["status"],
		summary: r.summary as string,
		artifacts: r.artifacts as string[],
		evidence: r.evidence as WorkerReport["evidence"],
	};
}

/**
 * Read + parse + v1 base-schema checks. Returns the parsed object on success.
 * <p>
 * FUNCTION_CONTRACT:
 * Input:
 *   - path: report file path
 *   - canonicalName: expected value of the report's "worker" field
 * Output: {ok:true, r} with the parsed JSON object, or {ok:false, error}
 * Guarantees:
 *   - enforces, in order: readable, non-empty, valid JSON, plain object,
 *     worker non-empty string === canonicalName, status ∈ {pass, fail},
 *     summary non-empty string, artifacts string[], evidence array of
 *     {claim, file} non-empty-string objects
 * Raises: never
 */
function baseValidate(
	path: string,
	canonicalName: string,
): { ok: true; r: Record<string, unknown> } | { ok: false; error: string } {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, error: `Report file not readable at ${path}: ${(err as Error).message}` };
	}
	if (raw.trim().length === 0) {
		return { ok: false, error: `Report file is empty: ${path}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `Report is not valid JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "Report must be a JSON object" };
	}
	const r = parsed as Record<string, unknown>;

	if (!isNonEmptyString(r.worker)) {
		return { ok: false, error: 'Report field "worker" must be a non-empty string' };
	}
	if (r.worker !== canonicalName) {
		return { ok: false, error: `Report "worker" is "${r.worker}" but canonical name is "${canonicalName}"` };
	}
	if (r.status !== "pass" && r.status !== "fail") {
		return { ok: false, error: `Report "status" must be "pass" or "fail", got: ${JSON.stringify(r.status)}` };
	}
	if (!isNonEmptyString(r.summary)) {
		return { ok: false, error: 'Report field "summary" must be a non-empty string' };
	}
	if (!Array.isArray(r.artifacts) || r.artifacts.some((a) => typeof a !== "string")) {
		return { ok: false, error: 'Report field "artifacts" must be an array of strings' };
	}
	if (!Array.isArray(r.evidence)) {
		return { ok: false, error: 'Report field "evidence" must be an array' };
	}
	for (const [i, item] of r.evidence.entries()) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			return { ok: false, error: `Evidence item ${i} must be an object` };
		}
		const e = item as Record<string, unknown>;
		if (!isNonEmptyString(e.claim) || !isNonEmptyString(e.file)) {
			return { ok: false, error: `Evidence item ${i} must have non-empty string "claim" and "file"` };
		}
	}

	return { ok: true, r };
}

/**
 * Extract the brief's `reportSchema` frontmatter key (JSON-Schema fragment).
 * Returns null when absent (v1 backward compat) — missing/unparseable
 * frontmatter or a non-object reportSchema is NOT an error.
 * Implementation note: use parseFrontmatter from @earendil-works/pi-coding-agent.
 */
export function parseBriefSchema(briefPath: string): Record<string, unknown> | null {
	let content: string;
	try {
		content = readFileSync(briefPath, "utf8");
	} catch {
		return null; // unreadable brief → no schema, never throw
	}
	let frontmatter: unknown;
	try {
		frontmatter = parseFrontmatter(content).frontmatter;
	} catch {
		return null; // corrupt frontmatter → no schema, never throw
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		return null;
	}
	const schema = (frontmatter as Record<string, unknown>).reportSchema;
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return null; // absent or non-object reportSchema → v1 backward compat
	}
	return schema as Record<string, unknown>;
}

/**
 * Validate a report against the v1 base schema AND the brief-declared fragment
 * (when non-null). Verified entry on this host is the exported 'typebox/value'
 * (see import note at top of file) — the deep specifiers
 *   "typebox/build/value/check/check.mjs" / "typebox/build/value/errors/index.mjs"
 * are BLOCKED by typebox 1.3.7's exports map (ERR_PACKAGE_PATH_NOT_EXPORTED,
 * reproduced under node ESM and jiti). No new deps.
 * Check(schema, value) accepts plain JSON-Schema objects (type/properties/
 * required/items/enum/minimum…); Errors(schema, value) yields
 * {instancePath, message}. Error messages must name the failing path
 * (e.g. "reportSchema: result.count must be integer").
 */
export function validateReportAgainstSchema(
	path: string,
	canonicalName: string,
	briefSchema: Record<string, unknown> | null,
): { ok: true; report: WorkerReport } | { ok: false; error: string } {
	const base = baseValidate(path, canonicalName);
	if (!base.ok) return base;
	if (briefSchema !== null && !Check(briefSchema, base.r)) {
		// First error is enough; Errors() yields {instancePath, message} with the
		// failing location as a JSON pointer in instancePath.
		const first = Errors(briefSchema, base.r)[0];
		const where =
			first?.instancePath && first.instancePath.length > 0
				? `${first.instancePath.replace(/^\//, "").split("/").join(".")} `
				: "";
		const detail = first ? `${where}${first.message}` : "failed schema validation";
		return { ok: false, error: `reportSchema: ${path} ${detail}` };
	}
	return { ok: true, report: reportOf(base.r) };
}

/**
 * Resolve the report schema for a brief. Returns the resolved JSON-Schema
 * fragment plus its provenance chain, or a rejection reason.
 * Semantics (DESIGN.md §16 + §11 backward compat): reportSchema ABSENT →
 * {ok:true, schema:null, provenance:[]} — base-only validation; schema-less
 * briefs remain valid. Inline object wins (provenance ["inline"]); a string
 * value names a library type; "$extends" chains merge parent-under-child
 * (properties union, required union, other keywords child-wins). Unknown
 * name / cycle / depth overflow / invalid JSON / non-object → {ok:false}.
 *
 * Contract (DESIGN.md §16, two-tier): when projectSchemaDir is provided it is
 * searched FIRST, before the user-level library ~/.pi/agent/pi-delegate-schemas/
 * — project overrides user (first match wins). The CALLER supplies the project
 * root (the orchestrator's cwd + ".pi/delegate-schemas"), because the brief path
 * itself (/tmp/exchange/<task>/) belongs to no project. Tests use
 * resolveReportSchemaInDir to inject a library dir.
 */
export function resolveReportSchema(
	briefPath: string,
	projectSchemaDir?: string,
): { ok: true; schema: Record<string, unknown> | null; provenance: string[] } | { ok: false; error: string } {
	return resolveReportSchemaInDir(briefPath, undefined, projectSchemaDir);
}

/** User-level schema library dir (DESIGN.md §16): under pi's agent dir
 *  (getAgentDir() — honors PI_CODING_AGENT_DIR, default ~/.pi/agent).
 *  Module-level constant computed from the pi export at module load. */
const USER_SCHEMA_DIR = join(getAgentDir(), "pi-delegate-schemas");

/** Max number of "$extends" hops in a chain (cycle-safe backstop). */
const MAX_SCHEMA_DEPTH = 8;

type SchemaResult =
	| { ok: true; schema: Record<string, unknown> | null; provenance: string[] }
	| { ok: false; error: string };

/**
 * resolveReportSchema with an injectable library dir (test seam — bun caches
 * os.homedir(), so $HOME overrides do NOT affect it at call time).
 * schemaDir omitted → real user-level library under pi's agent dir
 * (getAgentDir() — honors PI_CODING_AGENT_DIR).
 * projectSchemaDir (two-tier, §16): when provided, searched FIRST for every
 * library lookup (the root name and every "$extends" parent); user-level
 * (or the schemaDir test seam) is the fallback tier.
 */
export function resolveReportSchemaInDir(briefPath: string, schemaDir?: string, projectSchemaDir?: string): SchemaResult {
	let content: string;
	try {
		content = readFileSync(briefPath, "utf8");
	} catch (err) {
		return { ok: false, error: `Brief not readable at ${briefPath}: ${(err as Error).message}` };
	}
	let frontmatter: unknown;
	try {
		frontmatter = parseFrontmatter(content).frontmatter;
	} catch {
		// Backward compat (DESIGN.md §11): no frontmatter at all → base-only.
		return { ok: true, schema: null, provenance: [] };
	}
	if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
		return { ok: true, schema: null, provenance: [] };
	}
	const declared = (frontmatter as Record<string, unknown>).reportSchema;

	// Two-tier library search (DESIGN.md §16): project-local dir first, then
	// user-level (or the schemaDir test seam). First match wins.
	const load = (name: string) => {
		if (projectSchemaDir !== undefined) {
			const project = loadLibrarySchema(name, projectSchemaDir);
			if (project.ok) return project;
		}
		return loadLibrarySchema(name, schemaDir);
	};

	if (typeof declared === "object" && declared !== null && !Array.isArray(declared)) {
		// Inline fragment wins (v1.2 behavior, unchanged) — provenance root "inline".
		return resolveExtendsChain("inline", declared as Record<string, unknown>, load);
	}

	if (typeof declared === "string" && declared.length > 0) {
		const loaded = load(declared);
		if (!loaded.ok) return loaded;
		return resolveExtendsChain(declared, loaded.schema, load);
	}

	// reportSchema absent (or not object/string) → base-only (DESIGN.md §11).
	return { ok: true, schema: null, provenance: [] };
}

/**
 * Load one named schema from a single library dir. The two-tier search order
 * (project-local before user-level, §16) lives in the resolver
 * (resolveReportSchema/resolveReportSchemaInDir), which calls this per tier;
 * dirOverride selects the dir to load from (test seam).
 * Unreadable file / invalid JSON / non-object → {ok:false}, never throws.
 */
export function loadLibrarySchema(
	name: string,
	dirOverride?: string,
): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
	const dir = dirOverride ?? USER_SCHEMA_DIR;
	const path = join(dir, `${name}.json`);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		return { ok: false, error: `schema library file not readable at ${path}: ${(err as Error).message}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, error: `schema library file ${path} is not valid JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: `schema library file ${path} must contain a JSON-Schema object` };
	}
	return { ok: true, schema: parsed as Record<string, unknown> };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Merge parent-under-child: properties = union (child wins per key),
 * required = union (dedup), every other keyword = child's value when the
 * child declares it, else the parent's. The child's "$extends" (which named
 * the parent being consumed) is replaced by the parent's own "$extends"
 * (grandparent link) so the chain walk can continue.
 */
function mergeParentUnderChild(
	parent: Record<string, unknown>,
	child: Record<string, unknown>,
): Record<string, unknown> {
	const parentExtends = parent.$extends;
	const merged: Record<string, unknown> = { ...parent };
	for (const [key, value] of Object.entries(child)) merged[key] = value;

	if (parent.properties !== undefined || child.properties !== undefined) {
		merged.properties = {
			...(isPlainObject(parent.properties) ? parent.properties : {}),
			...(isPlainObject(child.properties) ? child.properties : {}),
		};
	}
	if (parent.required !== undefined || child.required !== undefined) {
		const req = [
			...(Array.isArray(parent.required) ? parent.required : []),
			...(Array.isArray(child.required) ? child.required : []),
		].filter((v): v is string => typeof v === "string");
		merged.required = [...new Set(req)];
	}
	delete merged.$extends;
	if (parentExtends !== undefined) merged.$extends = parentExtends;
	return merged;
}

/**
 * Resolve "$extends" chains iteratively: walk parent links, merging
 * parent-under-child at each hop. Cycle detection via a visited name set;
 * hard depth cap MAX_SCHEMA_DEPTH. Provenance = resolution order (child
 * first, e.g. ["impl-report", "qa-report"] / ["inline", ...parents]).
 */
function resolveExtendsChain(
	rootName: string,
	rootSchema: Record<string, unknown>,
	load: (name: string) => { ok: true; schema: Record<string, unknown> } | { ok: false; error: string },
): SchemaResult {
	const provenance: string[] = [rootName];
	const visited = new Set([rootName]);
	let current = rootSchema;
	let depth = 0;

	for (;;) {
		const extendsRaw = current.$extends;
		if (extendsRaw === undefined) return { ok: true, schema: current, provenance };
		if (typeof extendsRaw !== "string" || extendsRaw.length === 0) {
			return { ok: false, error: `schema "${provenance[provenance.length - 1]}" has a non-string "$extends"` };
		}
		if (visited.has(extendsRaw)) {
			return {
				ok: false,
				error: `schema "$extends" cycle detected: ${[...provenance, extendsRaw].join(" -> ")}`,
			};
		}
		if (++depth > MAX_SCHEMA_DEPTH) {
			return { ok: false, error: `schema "$extends" chain deeper than ${MAX_SCHEMA_DEPTH} starting at "${rootName}"` };
		}
		const parent = load(extendsRaw);
		if (!parent.ok) {
			return { ok: false, error: `resolving "$extends" of "${provenance[provenance.length - 1]}": ${parent.error}` };
		}
		visited.add(extendsRaw);
		current = mergeParentUnderChild(parent.schema, current);
		provenance.push(extendsRaw);
	}
}
