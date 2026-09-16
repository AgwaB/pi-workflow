import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { loadAgentByName } from "./agents.js";
import {
	isArtifactGraphWorkflowSpecShape,
	parseArtifactGraphWorkflowSpec,
} from "./artifact-graph-schema.js";
import { collectWorkflowBundleSourceFiles } from "./store.js";
import type {
	ArtifactGraphStageSpec,
	ArtifactGraphWorkflowSpec,
} from "./types.js";

/**
 * In-memory only selection snapshot. It is deliberately not persisted: v2
 * launch provenance retains opaque digests, not private source paths.
 */
export interface WorkflowAutoLaunchBinding {
	schema: "pi-workflow-auto-launch-binding-v1";
	candidateId: string;
	candidateIdentitySha256: string;
	taskSha256: string;
	specPath: string;
	resources: Array<{ relativePath: string; sha256: string }>;
	agents: Array<{ name: string; sourcePath: string; sha256: string }>;
	/** Selected profile/runtime inputs that affect the compiled execution. */
	launchSettingsSha256: string;
	/** Canonical project identity; a changed cwd invalidates an unlaunched selection. */
	cwdPath: string;
	cwdIdentity: { dev: number; ino: number };
	/** Content identity independent of the opaque selection identifier. */
	sourceIdentitySha256: string;
	/** Digest of the resolved post-profile compile settings when captured. */
	compiledSettingsSha256?: string;
	/** Direct dynamic uses the same source binding with a stable selected id. */
	runtimeVersion?: string;
}

/** Canonical settings payload shared by UI capture and engine revalidation. */
export function workflowAutoLaunchBindingSettings(input: {
	executionProfile?: unknown;
	executionProfileOverride?: unknown;
	runtimeDefaults?: { model?: unknown; thinking?: unknown };
	runtimeOverrides?: { model?: unknown; thinking?: unknown };
}): Record<string, unknown> {
	return {
		executionProfile: input.executionProfile ?? null,
		executionProfileOverride: input.executionProfileOverride ?? null,
		runtimeDefaults: {
			model: input.runtimeDefaults?.model ?? null,
			thinking: input.runtimeDefaults?.thinking ?? null,
		},
		runtimeOverrides: {
			model: input.runtimeOverrides?.model ?? null,
			thinking: input.runtimeOverrides?.thinking ?? null,
		},
	};
}

export async function captureWorkflowAutoLaunchBinding(input: {
	cwd: string;
	candidateId: string;
	task: string;
	specPath: string;
	spec: ArtifactGraphWorkflowSpec;
	/** Profile/runtime settings selected before the separate confirmation. */
	launchSettings?: unknown;
	/** Used by direct-dynamic, whose UI candidate id is intentionally stable. */
	selectionIdentitySha256?: string;
	runtimeVersion?: string;
	/** Projection of the actual selected compiled task settings. */
	compiledSettings?: unknown;
}): Promise<WorkflowAutoLaunchBinding> {
	const cwdPath = await realpath(input.cwd).catch(() => {
		throw new Error(
			"Auto selection is stale: current project directory is unavailable. Run /workflow auto again.",
		);
	});
	const cwdStat = await lstat(cwdPath);
	if (!cwdStat.isDirectory() || cwdStat.isSymbolicLink())
		throw new Error(
			"Auto selection is stale: current project directory is unsafe. Run /workflow auto again.",
		);
	const specPath = await realpath(input.specPath);
	const sourceFiles = await collectWorkflowBundleSourceFiles(
		input.cwd,
		specPath,
		input.spec,
	);
	const resourceBytes = await Promise.all(
		sourceFiles.map(async ({ relativePath, sourcePath }) => ({
			relativePath,
			bytes: await readBoundRegularFile(sourcePath, relativePath),
		})),
	);
	const resources = resourceBytes.map(({ relativePath, bytes }) => ({
		relativePath,
		sha256: sha256(bytes),
	}));
	const executableSpecs = [input.spec];
	const agentNameSet = collectAgentNames(input.spec);
	for (const resource of resourceBytes) {
		if (!resource.relativePath.endsWith(".json")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(resource.bytes.toString("utf8"));
		} catch {
			continue;
		}
		if (!isArtifactGraphWorkflowSpecShape(parsed)) continue;
		const nestedSpec = parseArtifactGraphWorkflowSpec(parsed);
		executableSpecs.push(nestedSpec);
		for (const name of collectAgentNames(nestedSpec)) agentNameSet.add(name);
	}
	assertNoUnfrozenExecutableRefs(executableSpecs, resourceBytes);
	const agentNames = [...agentNameSet].sort();
	const agents = await Promise.all(
		agentNames.map(async (name) => {
			const agent = await loadAgentByName(name, input.cwd);
			if (!agent)
				throw new Error(
					`Auto selection is stale: required agent "${name}" is unavailable`,
				);
			const sourcePath = await realpath(agent.sourcePath);
			return {
				name,
				sourcePath,
				sha256: sha256(
					await readBoundRegularFile(sourcePath, `agent ${name}`),
				),
			};
		}),
	);
	const launchSettingsSha256 = sha256(stableJson(input.launchSettings ?? {}));
	const compiledSettingsSha256 =
		input.compiledSettings === undefined
			? undefined
			: sha256(stableJson(input.compiledSettings));
	const cwdIdentity = { dev: cwdStat.dev, ino: cwdStat.ino };
	const sourceIdentitySha256 = sha256(
		stableJson({
			cwdPath,
			cwdIdentity,
			specPath,
			resources,
			agents,
			launchSettingsSha256,
			runtimeVersion: input.runtimeVersion,
		}),
	);
	return {
		schema: "pi-workflow-auto-launch-binding-v1",
		candidateId: input.candidateId,
		candidateIdentitySha256:
			input.selectionIdentitySha256 ??
			sha256(stableJson({ sourceIdentitySha256, compiledSettingsSha256 })),
		taskSha256: sha256(input.task.trim()),
		specPath,
		cwdPath,
		cwdIdentity,
		resources,
		agents,
		launchSettingsSha256,
		sourceIdentitySha256,
		...(compiledSettingsSha256 ? { compiledSettingsSha256 } : {}),
		...(input.runtimeVersion ? { runtimeVersion: input.runtimeVersion } : {}),
	};
}

/** Recheck mutable source identities before compilation or any scheduler work. */
export async function assertWorkflowAutoLaunchBindingCurrent(
	cwd: string,
	binding: WorkflowAutoLaunchBinding,
	spec: ArtifactGraphWorkflowSpec,
	task: string | undefined,
	actualSpecPath = binding.specPath,
	launchSettings?: unknown,
): Promise<void> {
	if (task === undefined || sha256(task.trim()) !== binding.taskSha256)
		throw new Error(
			"Auto selection is stale: task changed before launch. Run /workflow auto again.",
		);
	if (binding.launchSettingsSha256 !== sha256(stableJson(launchSettings ?? {})))
		throw new Error(
			"Auto selection is stale: profile or runtime changed before launch. Run /workflow auto again.",
		);
	const currentCwdPath = await realpath(cwd).catch(() => {
		throw new Error(
			"Auto selection is stale: current project directory changed before launch. Run /workflow auto again.",
		);
	});
	const currentCwdStat = await lstat(currentCwdPath);
	if (
		currentCwdPath !== binding.cwdPath ||
		!currentCwdStat.isDirectory() ||
		currentCwdStat.isSymbolicLink() ||
		currentCwdStat.dev !== binding.cwdIdentity.dev ||
		currentCwdStat.ino !== binding.cwdIdentity.ino
	)
		throw new Error(
			"Auto selection is stale: current project directory changed before launch. Run /workflow auto again.",
		);
	const resolvedActualSpecPath = await realpath(actualSpecPath);
	if (resolvedActualSpecPath !== binding.specPath)
		throw new Error(
			"Auto selection is stale: selected workflow path changed. Run /workflow auto again.",
		);
	const current = await captureWorkflowAutoLaunchBinding({
		cwd,
		candidateId: binding.candidateId,
		task,
		specPath: resolvedActualSpecPath,
		spec,
		launchSettings,
		runtimeVersion: binding.runtimeVersion,
		selectionIdentitySha256: binding.candidateIdentitySha256,
	});
	if (current.sourceIdentitySha256 !== binding.sourceIdentitySha256)
		throw new Error(
			"Auto selection is stale: workflow, schema, helper, or agent identity changed. Run /workflow auto again.",
		);
}

/** Seal or verify the exact effective task settings after compilation. */
export function sealWorkflowAutoLaunchBindingCompiled(
	binding: WorkflowAutoLaunchBinding,
	compiledSettings: unknown,
): WorkflowAutoLaunchBinding {
	const compiledSettingsSha256 = sha256(stableJson(compiledSettings));
	if (
		binding.compiledSettingsSha256 !== undefined &&
		binding.compiledSettingsSha256 !== compiledSettingsSha256
	)
		throw new Error(
			"Auto selection is stale: effective compiled settings changed before launch. Run /workflow auto again.",
		);
	return {
		...binding,
		compiledSettingsSha256,
	};
}

/**
 * The engine copies the selected bundle before scheduling. Compare that frozen
 * copy to the accepted snapshot before the first support/controller/provider
 * dispatch so a source-file race cannot silently launch different bytes.
 */
export async function assertWorkflowAutoLaunchBindingFrozen(
	cwd: string,
	runId: string,
	binding: WorkflowAutoLaunchBinding,
): Promise<void> {
	const bundleRoot = join(cwd, ".pi", "workflows", runId, "bundle");
	for (const resource of binding.resources) {
		const path = join(bundleRoot, resource.relativePath);
		let bytes: Buffer;
		try {
			const before = await lstat(path);
			if (!before.isFile() || before.isSymbolicLink())
				throw new Error("not a regular file");
			bytes = await readFile(path);
			const after = await lstat(path);
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.size !== before.size ||
				after.isSymbolicLink()
			)
				throw new Error("frozen bundle file changed while checked");
		} catch {
			throw new Error(
				`Auto selection is stale: frozen bundle is missing or unsafe: ${resource.relativePath}.`,
			);
		}
		if (sha256(bytes) !== resource.sha256)
			throw new Error(
				"Auto selection is stale: frozen bundle bytes changed. Run /workflow auto again.",
			);
	}
}

function assertNoUnfrozenExecutableRefs(
	specs: readonly ArtifactGraphWorkflowSpec[],
	resources: Array<{ relativePath: string; bytes: Buffer }>,
): void {
	const externalRefs = new Set<string>();
	const visit = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.extensions)) {
			for (const extension of record.extensions) {
				if (
					typeof extension === "string" &&
					extension.trim() &&
					!extension.startsWith("./")
				)
					externalRefs.add(`provider extension ${extension}`);
			}
		}
		for (const item of Object.values(record)) visit(item);
	};
	for (const spec of specs) visit(spec);
	for (const resource of resources) {
		if (!/\.(?:[cm]?js|[cm]?ts)$/i.test(resource.relativePath)) continue;
		const source = resource.bytes.toString("utf8");
		for (const match of source.matchAll(
			/(?:import|export)\s*(?:[^'";]*?\s*from\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g,
		)) {
			const ref = match[1] ?? match[2] ?? match[3];
			if (ref && !ref.startsWith(".") && !ref.startsWith("node:"))
				externalRefs.add(`code import ${ref}`);
		}
	}
	if (externalRefs.size > 0)
		throw new Error(
			"Auto selection cannot freeze external executable reference(s): " +
				[...externalRefs].sort().join(", ") +
				". Run an explicit launch after reviewing its provider boundary.",
		);
}

async function readBoundRegularFile(
	path: string,
	label: string,
): Promise<Buffer> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink())
		throw new Error(
			`Auto selection is stale: required source is missing or unsafe: ${label}.`,
		);
	const bytes = await readFile(path);
	const after = await lstat(path);
	if (
		!after.isFile() ||
		after.isSymbolicLink() ||
		after.dev !== before.dev ||
		after.ino !== before.ino ||
		after.size !== before.size
	)
		throw new Error(
			`Auto selection is stale: required source changed while read: ${label}.`,
		);
	return bytes;
}

function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.keys(value as Record<string, unknown>)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
		)
		.join(",")}}`;
}

function collectAgentNames(spec: ArtifactGraphWorkflowSpec): Set<string> {
	const names = new Set<string>();
	// The compiler defaults an omitted workflow agent to scout, so that implicit
	// source must be part of the accepted selection identity as well.
	names.add(spec.defaults?.agent ?? "scout");
	for (const role of Object.values(spec.roles ?? {}))
		if (role.fromAgent) names.add(role.fromAgent);
	for (const stage of flattenStages(spec.artifactGraph.stages)) {
		if (stage.agent) names.add(stage.agent);
		if (stage.each?.agent) names.add(stage.each.agent);
		const loop = stage.dynamic?.decisionLoop;
		for (const profile of [
			loop?.planner,
			loop?.workerDefaults,
			loop?.verifier,
			loop?.synthesis,
		])
			if (profile?.agent) names.add(profile.agent);
		for (const name of loop?.allowedAgents ?? []) names.add(name);
	}
	return names;
}

function flattenStages(
	stages: readonly ArtifactGraphStageSpec[],
): ArtifactGraphStageSpec[] {
	return stages.flatMap((stage) => [
		stage,
		...(stage.stages ? flattenStages(stage.stages) : []),
		...(stage.onExhausted ? flattenStages([stage.onExhausted]) : []),
	]);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}
