import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
	clampThinkingLevel,
	type Api,
	type Context,
	type Model,
	type ModelThinkingLevel,
	type OpenAICodexResponsesOptions,
	type OpenAIResponsesOptions,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	streamOpenAICodexResponses,
	streamOpenAIResponses,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { FastMode } from "./types.js";
import type { WorkflowModelInfo } from "./workflow-runtime.js";

export const WORKFLOW_FAST_SERVICE_TIER = "priority" as const;

type WorkflowFastApi = "openai-responses" | "openai-codex-responses";

const WORKFLOW_FAST_MODEL_APIS = new Map<string, WorkflowFastApi>([
	["openai/gpt-5.4", "openai-responses"],
	["openai/gpt-5.5", "openai-responses"],
	["openai-codex/gpt-5.4", "openai-codex-responses"],
	["openai-codex/gpt-5.5", "openai-codex-responses"],
	["openai-codex/gpt-5.6-sol", "openai-codex-responses"],
	["openai-codex/gpt-5.6-terra", "openai-codex-responses"],
	["openai-codex/gpt-5.6-luna", "openai-codex-responses"],
	["openai-codex/gpt-6-astra", "openai-codex-responses"],
	["openai-codex/gpt-6-sol", "openai-codex-responses"],
	["openai-codex/gpt-6-luna", "openai-codex-responses"],
]);

export interface WorkflowFastModeConfig {
	provider: "openai" | "openai-codex";
	model: string;
	api: WorkflowFastApi;
	serviceTier: typeof WORKFLOW_FAST_SERVICE_TIER;
}

export function workflowFastEligibleModelIds(): string[] {
	return [...WORKFLOW_FAST_MODEL_APIS.keys()];
}

/** Resolve and validate the task-bound Fast configuration before child launch. */
export function resolveWorkflowFastModeConfig(
	runtime: { fast?: FastMode; model?: string; api?: string },
	availableModels?: readonly WorkflowModelInfo[],
): WorkflowFastModeConfig | undefined {
	if (runtime.fast !== "on") return undefined;
	const fullId = runtime.model?.trim();
	if (!fullId) {
		throw new Error(
			"fast:on requires a resolved OpenAI model before workflow launch",
		);
	}
	const api = WORKFLOW_FAST_MODEL_APIS.get(fullId);
	if (!api) {
		throw new Error(
			`fast:on is not supported for model "${fullId}"; supported models: ${workflowFastEligibleModelIds().join(", ")}`,
		);
	}
	const provider = fullId.startsWith("openai-codex/")
		? "openai-codex"
		: "openai";
	const model = fullId.slice(provider.length + 1);
	const registered = availableModels?.find((entry) => entry.fullId === fullId);
	const boundApi = runtime.api ?? registered?.api;
	if (!boundApi) {
		throw new Error(
			`fast:on requires a resolved API binding for model "${fullId}" before workflow launch`,
		);
	}
	if (registered?.api !== undefined && registered.api !== api) {
		throw new Error(
			`fast:on requires ${api} for model "${fullId}"; Pi registered ${registered.api}`,
		);
	}
	if (boundApi !== api) {
		throw new Error(
			`fast:on requires ${api} for model "${fullId}"; workflow resolved ${boundApi}`,
		);
	}
	return {
		provider,
		model,
		api,
		serviceTier: WORKFLOW_FAST_SERVICE_TIER,
	};
}

export function applyWorkflowFastServiceTier(
	payload: unknown,
	config: WorkflowFastModeConfig,
): Record<string, unknown> {
	if (!isRecord(payload)) {
		throw new Error("workflow fast mode requires an object provider payload");
	}
	if (payload.model !== config.model) {
		throw new Error(
			`workflow fast mode payload binding mismatch: expected model ${config.model}, received ${formatPayloadModel(payload.model)}`,
		);
	}
	return { ...payload, service_tier: config.serviceTier };
}

export function buildWorkflowFastProviderOptions(
	options: unknown,
	config: WorkflowFastModeConfig,
	onFailure: () => void = () => undefined,
): Record<string, unknown> & {
	serviceTier: typeof WORKFLOW_FAST_SERVICE_TIER;
	onPayload: (payload: unknown, model: unknown) => Promise<Record<string, unknown>>;
} {
	const base = isRecord(options) ? options : {};
	const upstreamOnPayload =
		typeof base.onPayload === "function"
			? (base.onPayload as (payload: unknown, model: unknown) => unknown)
			: undefined;
	return {
		...base,
		serviceTier: config.serviceTier,
		onPayload: async (payload, model) => {
			try {
				assertWorkflowFastProviderModel(model, config);
				const replacement = await upstreamOnPayload?.(payload, model);
				return applyWorkflowFastServiceTier(replacement ?? payload, config);
			} catch (error) {
				onFailure();
				throw error;
			}
		},
	};
}

export interface WorkflowFastProviderStreams {
	openaiResponses: typeof streamOpenAIResponses;
	openaiCodexResponses: typeof streamOpenAICodexResponses;
}

const DEFAULT_WORKFLOW_FAST_PROVIDER_STREAMS: WorkflowFastProviderStreams = {
	openaiResponses: streamOpenAIResponses,
	openaiCodexResponses: streamOpenAICodexResponses,
};

export function registerWorkflowFastModeExtension(
	pi: ExtensionAPI,
	config: WorkflowFastModeConfig,
	streams: WorkflowFastProviderStreams = DEFAULT_WORKFLOW_FAST_PROVIDER_STREAMS,
): void {
	pi.on("session_start", (_event, context) => {
		installWorkflowFastProviderGuard(context, config, streams);
	});
	pi.on("before_provider_request", (event, context) => {
		assertWorkflowFastExtensionContext(context, config);
		try {
			return applyWorkflowFastServiceTier(event.payload, config);
		} catch (error) {
			context.abort();
			throw error;
		}
	});
}

export interface WorkflowFastModeExtensionWrapperOptions {
	wrapperPath: string;
	importPath: string;
	config: WorkflowFastModeConfig;
}

export function buildWorkflowFastModeExtensionWrapper(
	options: Omit<WorkflowFastModeExtensionWrapperOptions, "wrapperPath">,
): string {
	return [
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		`import { registerWorkflowFastModeExtension } from ${JSON.stringify(extensionImportSpecifier(options.importPath))};`,
		"",
		"export default function workflowFastModeGeneratedExtension(pi: ExtensionAPI): void {",
		`\tregisterWorkflowFastModeExtension(pi, ${JSON.stringify(options.config, null, "\t").replace(/\n/g, "\n\t")});`,
		"}",
		"",
	].join("\n");
}

export async function writeWorkflowFastModeExtensionWrapper(
	options: WorkflowFastModeExtensionWrapperOptions,
): Promise<string> {
	const wrapperPath = resolve(options.wrapperPath);
	await mkdir(dirname(wrapperPath), { recursive: true, mode: 0o700 });
	const content = buildWorkflowFastModeExtensionWrapper({
		importPath: options.importPath,
		config: options.config,
	});
	await writeFile(wrapperPath, content, { encoding: "utf8", mode: 0o600 });
	return wrapperPath;
}

export function createWorkflowFastProviderStream(
	config: WorkflowFastModeConfig,
	onFailure: () => void = () => undefined,
	streams: WorkflowFastProviderStreams = DEFAULT_WORKFLOW_FAST_PROVIDER_STREAMS,
) {
	return (
		model: Model<Api>,
		requestContext: Context,
		options?: SimpleStreamOptions,
	) => {
		try {
			assertWorkflowFastProviderModel(model, config);
		} catch (error) {
			onFailure();
			throw error;
		}
		const guardedOptions = buildWorkflowFastProviderOptions(
			options,
			config,
			onFailure,
		);
		const reasoningEffort = resolveReasoningEffort(model, options);
		if (config.api === "openai-codex-responses") {
			const providerOptions: OpenAICodexResponsesOptions = {
				...guardedOptions,
				reasoningEffort,
			};
			return streams.openaiCodexResponses(
				model as Model<"openai-codex-responses">,
				requestContext,
				providerOptions,
			);
		}
		const providerOptions: OpenAIResponsesOptions = {
			...guardedOptions,
			reasoningEffort,
		};
		return streams.openaiResponses(
			model as Model<"openai-responses">,
			requestContext,
			providerOptions,
		);
	};
}

function installWorkflowFastProviderGuard(
	context: ExtensionContext,
	config: WorkflowFastModeConfig,
	streams: WorkflowFastProviderStreams,
): void {
	context.modelRegistry.registerProvider(config.provider, {
		api: config.api,
		streamSimple: createWorkflowFastProviderStream(
			config,
			() => context.abort(),
			streams,
		),
	});
}

function resolveReasoningEffort(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): Exclude<ModelThinkingLevel, "off"> | undefined {
	if (!options?.reasoning) return undefined;
	const clamped = clampThinkingLevel(model, options.reasoning);
	return clamped === "off" ? undefined : clamped;
}

function assertWorkflowFastExtensionContext(
	context: ExtensionContext,
	config: WorkflowFastModeConfig,
): void {
	try {
		assertWorkflowFastProviderModel(context.model, config);
	} catch (error) {
		context.abort();
		throw error;
	}
}

function assertWorkflowFastProviderModel(
	model: unknown,
	config: WorkflowFastModeConfig,
): void {
	if (
		!isRecord(model) ||
		model.provider !== config.provider ||
		model.id !== config.model ||
		model.api !== config.api
	) {
		const actual = isRecord(model)
			? `${String(model.provider)}/${String(model.id)} (${String(model.api)})`
			: "no model";
		throw new Error(
			`workflow fast mode launch binding mismatch: expected ${config.provider}/${config.model} (${config.api}), received ${actual}`,
		);
	}
}

function extensionImportSpecifier(path: string): string {
	return pathToFileURL(resolve(path)).href;
}

function formatPayloadModel(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
