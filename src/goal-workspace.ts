import { createHash } from "node:crypto";
import { arr, digest, frozen, goalHash, id, nullable, obj, one, parse, unique, type Check } from "./goal-json.js";

/** Bounded byte/metadata contracts only. No IO, Git setup, link traversal or OS
 * protection. A real observer must prove completeness and stable path identity.
 * ASCII paths are deliberately conservative; unsupported paths fail closed. */
export interface GoalFileBytes { kind: "file"; links: 1; mode: "0644" | "0755"; hex: string }
/** Evidence only. The locator is resolved exclusively through the live host catalog. */
export interface GoalFileArtifact {
	kind: "artifact"; links: 1; mode: "0644" | "0755";
	locator: string; sha256: string; bytes: number; lines: number;
}
export type GoalFileValue = GoalFileBytes | GoalFileArtifact;
export interface GoalWorkspacePath { path: string; value: GoalFileValue | null }
export interface GoalOriginPath { path: string; head: GoalFileValue | null; index: GoalFileValue | null; worktree: GoalFileValue | null }
export interface GoalOriginObservation {
	schemaVersion: 1; originId: string; repository: "git" | "nonGit";
	headDigest: string | null; indexDigest: string | null; files: GoalOriginPath[];
}
export interface GoalWorkspaceBaseline {
	schemaVersion: 1; workspaceId: string; mode: "read-only" | "mutation";
	scope: string[]; protectedPaths: string[]; inputManifest: string[];
	origin: GoalOriginObservation;
}
export interface GoalWorkspaceCandidate {
	schemaVersion: 1; workspaceId: string; baselineHash: string; files: GoalWorkspacePath[];
}
export interface GoalWorkspaceDelta {
	schemaVersion: 1; workspaceId: string; baselineHash: string; candidateHash: string;
	paths: { path: string; before: GoalFileValue | null; after: GoalFileValue | null }[];
}

export const goalWorkspacePathCheck: Check = value => {
	if (typeof value !== "string" || value.length > 512 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) throw new Error("Goal unsafe/unsupported path metadata");
	for (const part of value.split("/")) {
		if ([".", "..", ".git", ".pi"].includes(part.toLowerCase()) || part.endsWith(".") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) throw new Error("Goal protected/ambiguous path metadata");
	}
};
export const goalFileBytesCheck: Check = obj({ kind: one("file"), links: one(1), mode: one("0644", "0755"), hex: value => {
	if (typeof value !== "string" || value.length > 16384 || !/^(?:[a-f0-9]{2})*$/.test(value)) throw new Error("Goal bounded canonical hex bytes required");
} });
export const goalFileArtifactCheck: Check = obj({
	kind: one("artifact"), links: one(1), mode: one("0644", "0755"),
	locator: value => {
		if (typeof value !== "string" || value.length > 256 || !/^[a-z]+\/[a-f0-9]{64}$/.test(value))
			throw new Error("Goal opaque artifact locator required");
	},
	sha256: digest,
	bytes: value => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new Error("Goal exact artifact byte census required");
	},
	lines: value => {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			throw new Error("Goal exact artifact line census required");
	},
});
export const goalFileValueCheck: Check = value => {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Goal file value required");
	if ((value as { kind?: unknown }).kind === "file") goalFileBytesCheck(value);
	else if ((value as { kind?: unknown }).kind === "artifact") goalFileArtifactCheck(value);
	else throw new Error("Goal file value kind required");
};
/** Stable content identity. Artifact locators are live-host routing evidence,
 * never part of a cross-observation byte identity. */
export function goalFileContentIdentity(value: GoalFileValue | null): {
	sha256: string; bytes: number; lines: number; mode: GoalFileValue["mode"]; links: 1;
} | null {
	if (value === null) return null;
	if (value.kind === "artifact")
		return {
			sha256: value.sha256, bytes: value.bytes, lines: value.lines,
			mode: value.mode, links: value.links,
		};
	const bytes = Buffer.from(value.hex, "hex");
	return {
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.length,
		lines: bytes.length === 0 ? 0 : bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0) + (bytes.at(-1) === 10 ? 0 : 1),
		mode: value.mode, links: value.links,
	};
}
const file = nullable(goalFileValueCheck);
const originShape = obj({ schemaVersion: one(1), originId: id, repository: one("git", "nonGit"), headDigest: nullable(digest), indexDigest: nullable(digest), files: arr(obj({ path: goalWorkspacePathCheck, head: file, index: file, worktree: file })) });
const pathShape = obj({ path: goalWorkspacePathCheck, value: file });
function paths(values: string[]): void {
	unique(values);
	const folded = values.map(p => p.toLowerCase()); unique(folded);
	if (folded.some(p => folded.some(q => p !== q && p.startsWith(`${q}/`)))) throw new Error("Goal file/ancestor path collision");
	if (goalHash(values) !== goalHash([...values].sort())) throw new Error("Goal paths must be sorted");
}
export function parseGoalOriginObservation(input: unknown): GoalOriginObservation {
	const data = parse<GoalOriginObservation>(input, originShape);
	paths(data.files.map(f => f.path));
	if (data.repository === "git" ? data.headDigest === null || data.indexDigest === null : data.headDigest !== null || data.indexDigest !== null || data.files.some(f => f.head !== null || f.index !== null)) throw new Error("Goal repository manifest semantics mismatch");
	return data;
}
export function parseGoalWorkspaceBaseline(input: unknown): GoalWorkspaceBaseline {
	const data = parse<GoalWorkspaceBaseline>(input, obj({ schemaVersion: one(1), workspaceId: id, mode: one("read-only", "mutation"), scope: arr(goalWorkspacePathCheck, 1), protectedPaths: arr(goalWorkspacePathCheck), inputManifest: arr(goalWorkspacePathCheck, 1), origin: value => { parseGoalOriginObservation(value); } }));
	paths(data.scope); paths(data.protectedPaths); paths(data.inputManifest);
	if (goalHash(data.scope) !== goalHash(data.inputManifest) || goalHash(data.scope) !== goalHash(data.origin.files.map(f => f.path))) throw new Error("Goal exact scoped input manifest required (including absent paths)");
	if (data.scope.some(p => data.protectedPaths.some(q => p.toLowerCase() === q.toLowerCase() || p.toLowerCase().startsWith(`${q.toLowerCase()}/`) || q.toLowerCase().startsWith(`${p.toLowerCase()}/`)))) throw new Error("Goal protected scope metadata");
	return data;
}
/** Informational requirement, never a claim that a worktree/staging area exists. */
export function goalWorkspaceRequirement(input: unknown): "no-worktree" | "managed-git-worktree-required" | "explicit-manifest-staging-required" {
	const baseline = parseGoalWorkspaceBaseline(input);
	return baseline.mode === "read-only" ? "no-worktree" : baseline.origin.repository === "git" ? "managed-git-worktree-required" : "explicit-manifest-staging-required";
}
export function parseGoalWorkspaceCandidate(input: unknown): GoalWorkspaceCandidate {
	const data = parse<GoalWorkspaceCandidate>(input, obj({ schemaVersion: one(1), workspaceId: id, baselineHash: digest, files: arr(pathShape, 1) }));
	paths(data.files.map(f => f.path)); return data;
}
/** First candidate includes staged + unstaged + scoped untracked working bytes.
 * The original HEAD and user index remain immutable in the baseline. */
export function initialGoalCandidate(input: unknown): GoalWorkspaceCandidate {
	const baseline = parseGoalWorkspaceBaseline(input);
	return parseGoalWorkspaceCandidate({ schemaVersion: 1, workspaceId: baseline.workspaceId, baselineHash: goalHash(baseline), files: baseline.origin.files.map(f => ({ path: f.path, value: f.worktree })) });
}
export function goalWorkspaceDelta(baselineInput: unknown, candidateInput: unknown): GoalWorkspaceDelta {
	const baseline = parseGoalWorkspaceBaseline(baselineInput);
	const candidate = parseGoalWorkspaceCandidate(candidateInput);
	if (candidate.baselineHash !== goalHash(baseline) || candidate.workspaceId !== baseline.workspaceId || goalHash(candidate.files.map(f => f.path)) !== goalHash(baseline.scope)) throw new Error("Goal candidate baseline/workspace/scope mismatch");
	const sameValue = (left: GoalFileValue | null, right: GoalFileValue | null) =>
		goalHash(goalFileContentIdentity(left)) === goalHash(goalFileContentIdentity(right));
	const changes = candidate.files.flatMap((f, i) => sameValue(f.value, baseline.origin.files[i].worktree) ? [] : [{ path: f.path, before: baseline.origin.files[i].worktree, after: f.value }]);
	if (baseline.mode === "read-only" && changes.length) throw new Error("Goal read-only candidate mutation rejected");
	return frozen({ schemaVersion: 1, workspaceId: baseline.workspaceId, baselineHash: goalHash(baseline), candidateHash: goalHash(candidate), paths: changes });
}
/** Sequential children propose replacement bytes against ONE immutable baseline;
 * no task reset, workspace recreation or in-place origin fallback exists here. */
export function updateGoalCandidate(baselineInput: unknown, previousInput: unknown, filesInput: unknown): GoalWorkspaceCandidate {
	const baseline = parseGoalWorkspaceBaseline(baselineInput);
	const previous = parseGoalWorkspaceCandidate(previousInput);
	goalWorkspaceDelta(baseline, previous);
	const files = parse<GoalWorkspacePath[]>(filesInput, arr(pathShape, 1));
	const next = parseGoalWorkspaceCandidate({ ...previous, files });
	goalWorkspaceDelta(baseline, next); return next;
}
