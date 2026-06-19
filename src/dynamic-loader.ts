import { pathToFileURL } from "node:url";

import { resolveWorkflowHelperRef } from "./workflow-helpers.js";
import { WorkflowValidationError } from "./types.js";

export interface DynamicArtifactRef {
	kind: "workflow-artifact-ref";
	name: string;
	options?: Record<string, unknown>;
}

export interface DynamicControllerContext {
	task: string;
	sources: Record<string, unknown>;
	phase: (name: string) => void;
	log: (...args: unknown[]) => void;
	artifact: (name: string, options?: Record<string, unknown>) => DynamicArtifactRef;
	graph: {
		generatedTaskIds: () => string[];
	};
	budget: {
		remaining: () => Record<string, number>;
		check: () => boolean;
	};
	helper: (name: string, input?: unknown) => Promise<unknown>;
	workflow: (name: string, input?: unknown) => Promise<unknown>;
	agent: (request: unknown) => Promise<unknown>;
	parallel: <T>(
		thunks: Array<() => T | Promise<T>>,
	) => Promise<Array<PromiseSettledResult<T>>>;
}

export type DynamicController = (
	ctx: DynamicControllerContext,
) => unknown | Promise<unknown>;

export async function loadDynamicController(
	ref: string,
	specPath: string,
): Promise<DynamicController> {
	const resolved = await resolveWorkflowHelperRef(ref, specPath);
	const imported = await import(pathToFileURL(resolved.path).href);
	if (typeof imported.default !== "function") {
		throw new WorkflowValidationError([
			{ path: ref, message: "dynamic controller must default-export a function" },
		]);
	}
	return imported.default as DynamicController;
}
