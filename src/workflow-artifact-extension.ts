import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	handleWorkflowArtifactToolCall,
	type WorkflowArtifactToolConfig,
} from "./workflow-artifact-tool.js";

export const WORKFLOW_ARTIFACT_TOOL_NAME = "workflow_artifact" as const;

const workflowArtifactParameters = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: {
			type: "string",
			enum: ["list", "read"],
			description: "List visible workflow artifacts or read one artifact.",
		},
		source: {
			type: "string",
			description: "Canonical source name from workflow_artifact list.",
		},
		artifact: {
			type: "string",
			enum: [
				"control",
				"analysis",
				"refs",
				"raw",
				"prompt",
				"system-prompt",
				"stderr",
				"result",
			],
			description: "Artifact kind to read when action is read.",
		},
	},
	required: ["action"],
} as const;

export function registerWorkflowArtifactTool(
	pi: ExtensionAPI,
	config: WorkflowArtifactToolConfig,
): void {
	pi.registerTool({
		name: WORKFLOW_ARTIFACT_TOOL_NAME,
		label: "Workflow Artifact",
		description:
			"List or read artifacts produced by upstream workflow stages. Reads are recorded for workflow required-read enforcement.",
		promptSnippet:
			"List/read upstream workflow artifacts by canonical source name; no filesystem paths are accepted.",
		promptGuidelines: [
			"Use workflow_artifact to inspect upstream workflow artifacts when the workflow prompt lists available sources or required reads.",
			"Call workflow_artifact with action=list to see visible source names before reading an artifact if unsure.",
			"Do not use repository read for workflow artifacts; workflow_artifact records required-read evidence.",
		],
		parameters: workflowArtifactParameters as any,
		async execute(_toolCallId: string, params: unknown) {
			return await handleWorkflowArtifactToolCall(params, config);
		},
	} as any);

	pi.on("session_start", () => {
		activateWorkflowArtifactTool(pi);
	});
	pi.on("before_agent_start", () => {
		activateWorkflowArtifactTool(pi);
	});
}

function activateWorkflowArtifactTool(pi: ExtensionAPI): void {
	const activeTools = new Set(pi.getActiveTools());
	activeTools.add(WORKFLOW_ARTIFACT_TOOL_NAME);
	pi.setActiveTools([...activeTools]);
}

export interface WorkflowArtifactExtensionWrapperOptions {
	wrapperPath: string;
	importPath: string;
	config: WorkflowArtifactToolConfig;
}

export function buildWorkflowArtifactExtensionWrapper(
	options: Omit<WorkflowArtifactExtensionWrapperOptions, "wrapperPath">,
): string {
	const importSpecifier = extensionImportSpecifier(options.importPath);
	return [
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";`,
		`import { registerWorkflowArtifactTool } from ${JSON.stringify(importSpecifier)};`,
		"",
		"export default function workflowArtifactGeneratedExtension(pi: ExtensionAPI): void {",
		`\tregisterWorkflowArtifactTool(pi, ${JSON.stringify(options.config, null, "\t").replace(/\n/g, "\n\t")});`,
		"}",
		"",
	].join("\n");
}

export async function writeWorkflowArtifactExtensionWrapper(
	options: WorkflowArtifactExtensionWrapperOptions,
): Promise<string> {
	const wrapperPath = resolve(options.wrapperPath);
	await mkdir(dirname(wrapperPath), { recursive: true });
	const content = buildWorkflowArtifactExtensionWrapper({
		importPath: options.importPath,
		config: options.config,
	});
	await writeFile(wrapperPath, content, "utf8");
	return wrapperPath;
}

function extensionImportSpecifier(importPath: string): string {
	if (isAbsolute(importPath)) return pathToFileURL(resolve(importPath)).href;
	return importPath;
}
