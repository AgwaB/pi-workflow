import type { CompiledTask, CompiledToolProvider, ToolClassification } from "./types.js";
import {
	workflowNativeLaunchTools,
	type WorkflowNativeHostContext,
} from "./workflow-native-host-context.js";

const CLASSIFICATION_RANK = {
	"read-only": 0,
	"write-capable": 1,
	"mutation-capable": 2,
} as const;

const NATIVE_TOOL_CLASSIFICATIONS = {
	codemode: "mutation-capable",
	tool_search: "read-only",
	"mcp__*": "mutation-capable",
	list_mcp_resources: "mutation-capable",
	list_mcp_resource_templates: "mutation-capable",
	read_mcp_resource: "mutation-capable",
} as const satisfies Record<string, ToolClassification>;

export interface WorkflowNativeToolPolicy {
	tools?: string[];
	toolProviders?: Record<string, CompiledToolProvider>;
	/** Present only when compilation intentionally considered a native host. */
	nativeToolsEnabled?: boolean;
}

/**
 * Expand a validated/authored tool selection into the native child-session
 * surface. Callers must perform authored authority checks before this helper:
 * codemode and active MCP inheritance are an intentional host-level expansion.
 */
export function applyWorkflowNativeToolPolicy(
	tools: readonly string[] | undefined,
	toolProviders: Record<string, CompiledToolProvider> | undefined,
	nativeHost: WorkflowNativeHostContext | undefined,
): WorkflowNativeToolPolicy {
	if (nativeHost === undefined) {
		const legacyPolicy: WorkflowNativeToolPolicy = {};
		if (tools !== undefined) legacyPolicy.tools = [...tools];
		if (toolProviders !== undefined)
			legacyPolicy.toolProviders = cloneToolProviders(toolProviders);
		return legacyPolicy;
	}

	if (tools?.length === 0) {
		const disabledPolicy: WorkflowNativeToolPolicy = {
			tools: [],
			nativeToolsEnabled: false,
		};
		if (toolProviders !== undefined)
			disabledPolicy.toolProviders = cloneToolProviders(toolProviders);
		return disabledPolicy;
	}

	const effectiveTools = workflowNativeLaunchTools(tools, nativeHost);
	const effectiveProviders = cloneToolProviders(toolProviders ?? {});
	for (const tool of effectiveTools ?? []) {
		const classification = nativeToolClassification(tool);
		if (classification === undefined) continue;
		effectiveProviders[tool] = withClassification(
			effectiveProviders[tool],
			classification,
		);
	}

	const enabledPolicy: WorkflowNativeToolPolicy = {
		nativeToolsEnabled: true,
	};
	if (effectiveTools !== undefined) enabledPolicy.tools = effectiveTools;
	if (Object.keys(effectiveProviders).length > 0)
		enabledPolicy.toolProviders = effectiveProviders;
	return enabledPolicy;
}

/** Repair old native-marked task metadata without rewriting the frozen compile artifact. */
export function prepareWorkflowNativeTaskPolicy(
	task: CompiledTask,
	nativeHost: WorkflowNativeHostContext | undefined,
): CompiledTask {
	if (nativeHost === undefined || task.runtime.nativeToolsEnabled !== undefined ||
		task.kind === "support" || task.kind === "dynamic") return task;
	const policy = applyWorkflowNativeToolPolicy(task.runtime.tools, task.runtime.toolProviders, nativeHost);
	return {
		...task,
		runtime: { ...task.runtime, ...policy },
		...(policy.nativeToolsEnabled !== true ? {} : {
			safety: {
				...task.safety,
				capability: "mutation-capable",
				sharedCwdSafe: false,
				requiresWorktree: task.safety.worktreePolicy !== "off",
				permission: task.runtime.approvalMode === "on-request"
					? { status: "blocked", statusDetail: "pending_approval", reason: "mutation-capable background task uses on-request approval mode" }
					: task.safety.permission,
			},
		}),
	};
}

function nativeToolClassification(
	tool: string,
): ToolClassification | undefined {
	if (tool.startsWith("mcp__")) return "mutation-capable";
	return NATIVE_TOOL_CLASSIFICATIONS[
		tool as keyof typeof NATIVE_TOOL_CLASSIFICATIONS
	];
}

function withClassification(
	provider: CompiledToolProvider | undefined,
	classification: ToolClassification,
): CompiledToolProvider {
	const current = provider?.classification;
	const result: CompiledToolProvider = provider ? { ...provider } : {};
	result.classification =
		current !== undefined &&
		CLASSIFICATION_RANK[current] > CLASSIFICATION_RANK[classification]
			? current
			: classification;
	return result;
}

function cloneToolProviders(
	providers: Record<string, CompiledToolProvider>,
): Record<string, CompiledToolProvider> {
	return Object.fromEntries(
		Object.entries(providers).map(([tool, provider]) => {
			const copy: CompiledToolProvider = { ...provider };
			if (provider.extensions !== undefined)
				copy.extensions = [...provider.extensions];
			if (provider.fallbackTools !== undefined)
				copy.fallbackTools = [...provider.fallbackTools];
			return [tool, copy];
		}),
	);
}
