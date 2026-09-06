/**
 * pi-delegate — exchange dir conventions and manifest (DESIGN.md §6).
 *
 * OWNERSHIP: contract authored by the tech lead; implementation owned by
 * worker A (impl-transport). Worker B imports but never edits this file.
 *
 * Conventions:
 *   /tmp/exchange/{TASK}/manifest.json    — extension-written source of truth
 *   /tmp/exchange/{TASK}/brief-<name>.md  — orchestrator-written, tool-validated
 *   /tmp/exchange/{TASK}/report-<name>.json — worker-written, schema-validated
 */

import { parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
// typebox Value.Check/Errors — NOTE: the contract's deep specifiers
// ("typebox/build/value/check/check.mjs") are blocked by typebox 1.3.7's
// exports map (ERR_PACKAGE_PATH_NOT_EXPORTED, verified via node + jiti);
// "typebox/value" is the exported entry for the same build/value modules.
import { Check, Errors } from "typebox/value";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { DelegateError, DelegateErrorCode, Placement, WorkerReport } from "./transport/types.ts";

/** Exchange root — all task dirs live directly under it. */
const EXCHANGE_ROOT = "/tmp/exchange";

export interface ManifestWorker {
	/** Canonical (herdr-confirmed) name. */
	name: string;
	placement: Placement;
	briefPath: string;
	reportPath: string;
	provider: string;
	model: string;
	thinking: string;
	startedAt: string; // ISO 8601
	/** Worker session JSONL path (budget accounting, DESIGN.md §14) — captured
	 *  from the herdr `agent start` result when the transport exposes it. */
	sessionPath?: string;
	/** Resolved effective budget for the spawn (per-call > config > default),
	 *  recorded so delegate_status can display usage against the real budget. */
	budgetTokens?: number;
	/** v1.5 (DESIGN.md §17): resolved report-schema provenance chain
	 *  ("inline" / library type names, in resolution order). */
	schemaProvenance?: string[];
	/** v1.5 (DESIGN.md §17): MERGED report-schema fragment the report was held
	 *  to — quoted when collect rejects a report, so failures are auditable. */
	reportSchemaFragment?: Record<string, unknown>;
	/** ISO 8601 — set by COLLECT only, on successful report delivery. The
	 *  watcher reads it to stay silent about an already-collected report (its
	 *  `seen` dedup lives only inside a session, so a fresh session would
	 *  otherwise re-wake on old reports). The watcher never writes it. */
	collectedAt?: string;
	/** Session JSONL path of the ORCHESTRATOR that spawned this worker, captured
	 *  through the live sessionManager getter at spawn time. The watcher wakes
	 *  only this session (ownership by session path — the `isSelf` idiom);
	 *  absent on legacy manifests → legacy behavior (every session sees the
	 *  events). Deliberately NOT refreshed on /new or /resume: a new session
	 *  inherits no wake-ups. Written only by spawn; the watcher is a reader. */
	orchestratorSessionPath?: string;
}

export interface ExchangeManifest {
	task: string;
	dir: string;
	workers: ManifestWorker[];
}

export interface ExchangeDir {
	dir: string;
	/** Short task slug (directory basename under /tmp/exchange). */
	task: string;
	briefPath: string;
	reportPath: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ExchangeDelegateError extends Error implements DelegateError {
	readonly code: DelegateErrorCode;
	readonly guidance: string;
	override cause?: unknown;

	constructor(code: DelegateErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "DelegateError";
		this.code = code;
		this.guidance = E_BRIEF_GUIDANCE;
		if (cause !== undefined) this.cause = cause;
	}
}

const E_BRIEF_GUIDANCE = "Write the brief file first, then retry the delegate call.";

// ---------------------------------------------------------------------------
// Path validation + ensureExchangeDir
// ---------------------------------------------------------------------------

/**
 * Validate and open the exchange dir for a brief.
 * Rules: briefPath absolute, inside /tmp/exchange/<task>/, file exists and is
 * non-empty. Throws a DelegateError with code E_BRIEF otherwise.
 */
export function ensureExchangeDir(briefPathRaw: string): ExchangeDir {
	// Normalize a leading @ (models sometimes prefix tool path args with it).
	const briefPath = briefPathRaw.startsWith("@") ? briefPathRaw.slice(1) : briefPathRaw;

	if (!briefPath || !isAbsolute(briefPath)) {
		throw new ExchangeDelegateError(
			"E_BRIEF",
			`Brief path must be absolute, got: "${briefPathRaw}"`,
		);
	}
	const brief = resolve(briefPath);
	const dir = dirname(brief);
	const task = basename(dir);
	const parent = dirname(dir);

	if (resolve(parent) !== EXCHANGE_ROOT) {
		throw new ExchangeDelegateError(
			"E_BRIEF",
			`Brief must live directly inside ${EXCHANGE_ROOT}/<task>/ — parent dir of "${dir}" is "${parent}"`,
		);
	}
	if (!task || task === basename(EXCHANGE_ROOT)) {
		throw new ExchangeDelegateError("E_BRIEF", `Missing task slug in brief path: "${brief}"`);
	}

	let content: string;
	try {
		content = readFileSync(brief, "utf8");
	} catch (err) {
		throw new ExchangeDelegateError(
			"E_BRIEF",
			`Brief file not readable at ${brief}: ${(err as Error).message}`,
			err,
		);
	}
	if (content.trim().length === 0) {
		throw new ExchangeDelegateError("E_BRIEF", `Brief file is empty: ${brief}`);
	}

	// Conventional report path: brief-<name>.md → report-<name>.json (sibling).
	const briefName = basename(brief);
	const nameMatch = /^brief-(.+)\.md$/.exec(briefName);
	const reportPath = nameMatch ? reportPathFor(dir, nameMatch[1]) : "";

	return { dir, task, briefPath: brief, reportPath };
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function manifestPath(dir: string): string {
	return resolve(dir, "manifest.json");
}

/** Read the manifest; null when absent (first worker of a task) or corrupt. */
export function readManifest(dir: string): ExchangeManifest | null {
	const path = manifestPath(dir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent (or unreadable) → treat as no manifest yet
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ExchangeManifest>;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.task !== "string" ||
			typeof parsed.dir !== "string" ||
			!Array.isArray(parsed.workers)
		) {
			return null; // corrupt → tolerant read, no throw
		}
		return parsed as ExchangeManifest;
	} catch {
		return null;
	}
}

function atomicWriteFileSync(path: string, content: string): void {
	const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path); // rename is atomic on the same filesystem
}

/**
 * Mutate-and-persist the manifest. Must serialize concurrent mutations
 * (use withFileMutationQueue from @earendil-works/pi-coding-agent on the
 * manifest path) so parallel delegate calls cannot clobber each other.
 */
export function updateManifest(
	dir: string,
	mutate: (m: ExchangeManifest) => ExchangeManifest,
): Promise<ExchangeManifest> {
	const path = manifestPath(dir);
	return withFileMutationQueue(path, async () => {
		mkdirSync(dir, { recursive: true });
		const current = readManifest(dir);
		const base: ExchangeManifest = current ?? { task: basename(dir), dir: resolve(dir), workers: [] };
		const next = mutate(base);
		atomicWriteFileSync(path, JSON.stringify(next, null, "\t") + "\n");
		return next;
	});
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Conventional report path for a worker. */
export function reportPathFor(dir: string, name: string): string {
	return `${dir}/report-${name}.json`;
}

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

/** Read + parse + v1 base-schema checks. Returns the parsed object on success. */
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

// ---------------------------------------------------------------------------
// Global scan
// ---------------------------------------------------------------------------

/** Scan all /tmp/exchange/<task>/manifest.json — the delegate_status data source. */
export function scanAllManifests(): ExchangeManifest[] {
	let entries: string[];
	try {
		entries = readdirSync(EXCHANGE_ROOT, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
	} catch {
		return []; // no exchange dir yet
	}
	const manifests: ExchangeManifest[] = [];
	for (const task of entries) {
		const m = readManifest(resolve(EXCHANGE_ROOT, task));
		if (m) manifests.push(m);
	}
	return manifests;
}

// ---------------------------------------------------------------------------
// v1.2 contracts — brief-declared schemas + mailbox (DESIGN.md §11–§12).
// Contract authored by the tech lead; implementation owned by worker A2
// (impl-mailbox). Worker B2 imports but never edits this file.
// ---------------------------------------------------------------------------

import {
	isProgressEvent,
	isQuestionEnvelope,
	type AnswerEnvelope,
	type QuestionEnvelope,
} from "./transport/types.ts";

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

/** Mailbox paths, next to the brief. */
export function questionPathFor(dir: string, name: string): string {
	return `${dir}/q-${name}.json`;
}

export function answerPathFor(dir: string, name: string): string {
	return `${dir}/a-${name}.json`;
}

/** Read + validate a pending question; null when absent/invalid. */
export function readQuestion(path: string): QuestionEnvelope | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent/unreadable → no pending question
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isQuestionEnvelope(parsed) ? parsed : null;
	} catch {
		return null; // corrupt JSON → no pending question, never throw
	}
}

/** Write an answer envelope atomically (tmp+rename; withFileMutationQueue on the path). */
export function writeAnswer(path: string, answer: string): Promise<void> {
	const envelope: AnswerEnvelope = {
		from: "orchestrator",
		ts: new Date().toISOString(),
		answer,
	};
	return withFileMutationQueue(path, async () => {
		mkdirSync(dirname(path), { recursive: true });
		atomicWriteFileSync(path, JSON.stringify(envelope, null, "\t") + "\n");
	});
}

// ---------------------------------------------------------------------------
// v1.5 contracts — schema library/inheritance + progress pings
// (DESIGN.md §16–§18). Contract authored by the tech lead; implementation
// owned by worker A5 (impl-schemas). Worker B5 imports, never edits.
// ---------------------------------------------------------------------------

import type { ProgressEvent } from "./transport/types.ts";

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

/** User-level schema library dir, relative to $HOME (DESIGN.md §16). */
const USER_SCHEMA_DIR = ".pi/agent/pi-delegate-schemas";

/** Max number of "$extends" hops in a chain (cycle-safe backstop). */
const MAX_SCHEMA_DEPTH = 8;

type SchemaResult =
	| { ok: true; schema: Record<string, unknown> | null; provenance: string[] }
	| { ok: false; error: string };

/**
 * resolveReportSchema with an injectable library dir (test seam — bun caches
 * os.homedir(), so $HOME overrides do NOT affect it at call time).
 * schemaDir omitted → real user-level library under homedir().
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
	const dir = dirOverride ?? join(homedir(), USER_SCHEMA_DIR);
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

/** Conventional progress-ping path for a worker. */
export function progressPathFor(dir: string, name: string): string {
	return `${dir}/p-${name}.jsonl`;
}

/**
 * Read the LAST valid ping from p-<name>.jsonl (file may not exist, may be
 * mid-append — tolerate partial last line). Scan lines from the END, skipping
 * corrupt/partial/non-progress lines; the first line passing isProgressEvent
 * wins. Returns null when absent/empty/none-valid. Never throws.
 */
export function readLastProgress(path: string): ProgressEvent | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent/unreadable → no ping yet
	}
	const lines = raw.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue; // corrupt or partial tail line → keep scanning backwards
		}
		if (isProgressEvent(parsed)) return parsed;
	}
	return null;
}
