import { createHash } from "node:crypto";

import {
	WORKFLOW_PROFILE_ROLES,
	type ArtifactGraphStageSpec,
	type ArtifactGraphWorkflowSpec,
	type ExecutionProfileForeachBatch,
	type ExecutionProfileStageOverride,
	type WorkflowProfileRole,
	type WorkflowCapturedExecutionProfile,
	type WorkflowRunExecutionProfile,
} from "./types.js";

/** Stable identity for one complete parsed workflow definition. */
export function workflowDefinitionFingerprint(spec: unknown): string {
	return createHash("sha256").update(stableJson(spec)).digest("hex");
}

/** Internal profile overlay metadata; symbols cannot be authored in JSON specs. */
export const EXECUTION_PROFILE_FOREACH_BATCH = Symbol(
	"workflow.executionProfileForeachBatch",
);

export type ProfiledArtifactGraphStage = Record<string, unknown> & {
	[EXECUTION_PROFILE_FOREACH_BATCH]?: ExecutionProfileForeachBatch;
};

export interface WorkflowProfileStageSlot {
	/** Canonical execution-profile target id. */
	id: string;
	/** Authored model-purpose role; absent on legacy/incomplete profile specs. */
	profileRole?: WorkflowProfileRole;
	/** True for a dynamic decision-loop profile rather than an artifact stage. */
	kind: "stage" | "dynamic-profile";
}

type ExecutionProfileTarget = WorkflowProfileStageSlot & {
	target: Record<string, unknown>;
};

const DYNAMIC_PROFILE_SLOTS = [
	"planner",
	"workerDefaults",
	"verifier",
	"synthesis",
] as const;

/**
 * Return every model-bearing slot addressable by a user workflow profile.
 * Containers/support helpers are omitted; nested dag/loop stages, loop
 * exhaustion stages and declared dynamic decision profiles are included.
 */
export function collectWorkflowProfileStageSlots(
	spec: ArtifactGraphWorkflowSpec,
): WorkflowProfileStageSlot[] {
	return collectExecutionProfileTargets(spec)
		.filter(({ target, kind }) =>
			kind === "dynamic-profile" ? true : isModelBackedStage(target),
		)
		.map(({ id, profileRole, kind }) => ({ id, profileRole, kind }));
}

export interface ApplyExecutionProfileStageOverridesOptions {
	/** Preserve legacy declared-profile layering by default; user profiles use each. */
	foreachRuntimeTarget?: "stage" | "each";
}

/** Apply one already-validated mapping without mutating the authored spec. */
export function applyExecutionProfileStageOverrides<
	Spec extends ArtifactGraphWorkflowSpec,
>(
	spec: Spec,
	mapping: Readonly<Record<string, ExecutionProfileStageOverride>>,
	options: ApplyExecutionProfileStageOverridesOptions = {},
): Spec {
	const targets = collectExecutionProfileTargets(spec);
	const targetIds = new Set(targets.map(({ id }) => id));
	const unknown = Object.keys(mapping).filter((id) => !targetIds.has(id));
	if (unknown.length > 0) {
		throw new Error(
			`execution profile targets unknown stage slot(s): ${unknown.sort().join(", ")}`,
		);
	}

	const graph = spec.artifactGraph;
	const stages = graph.stages.map((stage) =>
		mapStage(
			stageRecord(stage),
			stage.id,
			mapping,
			options.foreachRuntimeTarget === "each",
		),
	);
	return {
		...spec,
		artifactGraph: {
			...graph,
			stages,
		},
	};
}

/**
 * Resolve a declared or UI-captured profile into an immutable stage overlay.
 * Kept outside the engine so auto selection can bind the exact post-profile
 * compile input before its separate launch confirmation.
 */
export function applyWorkflowExecutionProfile<Spec>(
	spec: Spec,
	profileName: string | undefined,
	profileOverride: WorkflowCapturedExecutionProfile | undefined,
): { spec: Spec; record?: WorkflowRunExecutionProfile } {
	const profiles = (
		spec as {
			executionProfiles?: Record<
				string,
				Record<string, ExecutionProfileStageOverride>
			>;
		}
	).executionProfiles;
	let selectedName = profileName;
	let mapping: Record<string, ExecutionProfileStageOverride> | undefined;
	if (profileName) {
		mapping = profiles?.[profileName];
		if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
			const available = Object.keys(profiles ?? {}).sort((left, right) =>
				left.localeCompare(right),
			);
			throw new Error(
				available.length
					? `unknown execution profile "${profileName}"; spec declares: ${available.join(", ")}`
					: `unknown execution profile "${profileName}"; this workflow declares no executionProfiles`,
			);
		}
	} else if (profileOverride) {
		selectedName = profileOverride.name;
		mapping = profileOverride.stageOverrides;
		if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
			throw new Error("pre-resolved execution profile has invalid stageOverrides");
	}
	if (!selectedName || !mapping) return { spec };
	if (typeof selectedName !== "string" || !selectedName.trim())
		throw new Error("execution profile name is empty or invalid");
	const graph = (spec as { artifactGraph?: { stages?: unknown[] } })
		.artifactGraph;
	if (!graph || !Array.isArray(graph.stages)) {
		throw new Error(
			`execution profile "${selectedName}" requires an artifact-graph workflow`,
		);
	}
	const stageOverrides = Object.fromEntries(
		Object.entries(mapping).map(([stageId, override]) => [
			stageId,
			cloneExecutionProfileStageOverride(override),
		]),
	);
	return {
		spec: applyExecutionProfileStageOverrides(spec as never, stageOverrides, {
			// Authored profile values preserve each.* precedence; saved UI profiles
			// deliberately target effective foreach workers.
			foreachRuntimeTarget: profileName ? "stage" : "each",
		}) as Spec,
		record: {
			name: selectedName,
			...(profileName === undefined && profileOverride?.definitionFingerprint
				? { definitionFingerprint: profileOverride.definitionFingerprint }
				: {}),
			stageOverrides,
		},
	};
}

export function cloneExecutionProfileStageOverride(
	override: ExecutionProfileStageOverride,
): ExecutionProfileStageOverride {
	return {
		...(override.model === undefined ? {} : { model: override.model }),
		...(override.thinking === undefined ? {} : { thinking: override.thinking }),
		...(override.foreachBatch === undefined
			? {}
			: {
					foreachBatch: cloneExecutionProfileForeachBatch(override.foreachBatch),
				}),
	};
}

export function cloneExecutionProfileForeachBatch(
	batch: ExecutionProfileForeachBatch,
): ExecutionProfileForeachBatch {
	return {
		maxItems: 2,
		...(batch.groupBy === undefined
			? {}
			: {
					groupBy: Array.isArray(batch.groupBy) ? [...batch.groupBy] : batch.groupBy,
				}),
	};
}

function collectExecutionProfileTargets(
	spec: ArtifactGraphWorkflowSpec,
): ExecutionProfileTarget[] {
	const targets: ExecutionProfileTarget[] = [];
	const visit = (stage: Record<string, unknown>, canonicalId: string): void => {
		targets.push({
			id: canonicalId,
			profileRole: profileRoleOf(stage),
			kind: "stage",
			target: stage,
		});

		if (
			(stage.type === "dag" || stage.type === "loop") &&
			Array.isArray(stage.stages)
		) {
			for (const child of stage.stages) {
				if (!isRecord(child) || typeof child.id !== "string") continue;
				visit(child, `${canonicalId}.${child.id}`);
			}
		}
		if (stage.type === "loop" && isRecord(stage.onExhausted)) {
			visit(stage.onExhausted, `${canonicalId}.$onExhausted`);
		}
		if (stage.type === "dynamic") {
			const dynamic = isRecord(stage.dynamic) ? stage.dynamic : undefined;
			const decisionLoop = isRecord(dynamic?.decisionLoop)
				? dynamic.decisionLoop
				: undefined;
			for (const slot of DYNAMIC_PROFILE_SLOTS) {
				const target = decisionLoop?.[slot];
				if (!isRecord(target)) continue;
				targets.push({
					id: `${canonicalId}.$${slot}`,
					profileRole: profileRoleOf(target),
					kind: "dynamic-profile",
					target,
				});
			}
		}
	};

	for (const stage of spec.artifactGraph.stages)
		visit(stageRecord(stage), stage.id);
	return targets;
}

function mapStage(
	stage: Record<string, unknown>,
	canonicalId: string,
	mapping: Readonly<Record<string, ExecutionProfileStageOverride>>,
	foreachRuntimeOnEach: boolean,
): Record<string, unknown> {
	let next = applyOverride(
		stage,
		mapping[canonicalId],
		stage.type === "foreach" && foreachRuntimeOnEach,
	);

	if (
		(stage.type === "dag" || stage.type === "loop") &&
		Array.isArray(stage.stages)
	) {
		const stages = stage.stages.map((child) =>
			isRecord(child) && typeof child.id === "string"
				? mapStage(
						child,
						`${canonicalId}.${child.id}`,
						mapping,
						foreachRuntimeOnEach,
					)
				: child,
		);
		next = { ...next, stages };
	}
	if (stage.type === "loop" && isRecord(stage.onExhausted)) {
		next = {
			...next,
			onExhausted: mapStage(
				stage.onExhausted,
				`${canonicalId}.$onExhausted`,
				mapping,
				foreachRuntimeOnEach,
			),
		};
	}
	if (stage.type === "dynamic" && isRecord(stage.dynamic)) {
		const decisionLoop = isRecord(stage.dynamic.decisionLoop)
			? stage.dynamic.decisionLoop
			: undefined;
		if (decisionLoop) {
			let nextLoop: Record<string, unknown> = decisionLoop;
			for (const slot of DYNAMIC_PROFILE_SLOTS) {
				const profile = decisionLoop[slot];
				if (!isRecord(profile)) continue;
				nextLoop = {
					...nextLoop,
					[slot]: applyOverride(profile, mapping[`${canonicalId}.$${slot}`], false),
				};
			}
			next = {
				...next,
				dynamic: {
					...stage.dynamic,
					decisionLoop: nextLoop,
				},
			};
		}
	}
	return next;
}

function applyOverride(
	target: Record<string, unknown>,
	override: ExecutionProfileStageOverride | undefined,
	foreach: boolean,
): Record<string, unknown> {
	if (!override) return target;
	const runtimeOverride = {
		...(override.model === undefined ? {} : { model: override.model }),
		...(override.thinking === undefined ? {} : { thinking: override.thinking }),
	};
	const runtimeTarget =
		foreach && isRecord(target.each)
			? { each: { ...target.each, ...runtimeOverride } }
			: runtimeOverride;
	return {
		...target,
		...runtimeTarget,
		...(override.foreachBatch === undefined
			? {}
			: {
					[EXECUTION_PROFILE_FOREACH_BATCH]: cloneExecutionProfileForeachBatch(
						override.foreachBatch,
					),
				}),
	};
}

function stageRecord(stage: ArtifactGraphStageSpec): Record<string, unknown> {
	// SAFETY: parsed stage specs are validated plain JSON objects with string keys.
	return stage as unknown as Record<string, unknown>;
}

function isModelBackedStage(stage: Record<string, unknown>): boolean {
	return (
		stage.support === undefined &&
		(stage.type === "single" ||
			stage.type === "foreach" ||
			stage.type === "reduce" ||
			stage.type === "dynamic")
	);
}

function profileRoleOf(
	value: Record<string, unknown>,
): WorkflowProfileRole | undefined {
	return WORKFLOW_PROFILE_ROLES.includes(
		value.profileRole as WorkflowProfileRole,
	)
		? (value.profileRole as WorkflowProfileRole)
		: undefined;
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
