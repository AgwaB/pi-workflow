import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { parseArtifactGraphWorkflowSpec } from "./artifact-graph-schema.js";
import { validateJsonSchemaSubset } from "./json-schema.js";
import {
	type ArtifactGraphWorkflowSpec,
	WorkflowValidationError,
	type ValidationIssue,
} from "./types.js";
import {
	type ResolvedWorkflowSpecRef,
	resolveWorkflowRef,
} from "./workflow-specs.js";

export interface LoadedWorkflowSpec extends ResolvedWorkflowSpecRef {
	spec: ArtifactGraphWorkflowSpec;
}

export async function loadWorkflowSpec(
	specRef: string,
	cwd: string,
): Promise<LoadedWorkflowSpec> {
	const resolved = await resolveWorkflowRef(specRef, cwd);
	let parsed: unknown;

	try {
		parsed = parseSpecText(
			await readFile(resolved.specPath, "utf8"),
			resolved.specPath,
		);
	} catch (error) {
		if (error instanceof WorkflowValidationError) throw error;
		throw new WorkflowValidationError([
			{
				path: specRef,
				message: error instanceof Error ? error.message : String(error),
			},
		]);
	}

	const spec = parseWorkflow(parsed);
	await validateArtifactGraphControlSchemaFiles(spec, resolved.specPath);
	return {
		...resolved,
		spec,
	};
}

async function validateArtifactGraphControlSchemaFiles(
	spec: ArtifactGraphWorkflowSpec,
	specPath: string,
): Promise<void> {
	const issues: ValidationIssue[] = [];
	const specDir = dirname(specPath);
	const seen = new Set<string>();
	for (const stage of flattenArtifactGraphStages(spec.artifactGraph.stages)) {
		const controlSchema = stage.output?.controlSchema;
		if (!controlSchema || seen.has(controlSchema)) continue;
		seen.add(controlSchema);
		const schemaPath = resolve(specDir, controlSchema);
		try {
			const [realSpecDir, realSchemaPath] = await Promise.all([
				realpath(specDir),
				realpath(schemaPath),
			]);
			if (!isInsidePath(realSpecDir, realSchemaPath)) {
				issues.push({
					path: `${stage.id}.output.controlSchema`,
					message: `controlSchema must stay inside the workflow bundle: ${controlSchema}`,
				});
				continue;
			}
			const schema = JSON.parse(await readFile(realSchemaPath, "utf8"));
			const validation = validateJsonSchemaSubset(schema);
			for (const issue of validation.issues) {
				issues.push({
					path: `${stage.id}.output.controlSchema${issue.path.slice(1)}`,
					message: issue.message,
				});
			}
		} catch (error) {
			issues.push({
				path: `${stage.id}.output.controlSchema`,
				message: `controlSchema not readable JSON: ${controlSchema} (${error instanceof Error ? error.message : String(error)})`,
			});
		}
	}
	if (issues.length > 0) throw new WorkflowValidationError(issues);
}

function isInsidePath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function flattenArtifactGraphStages(stages: readonly any[]): any[] {
	return stages.flatMap((stage) => [
		stage,
		...(Array.isArray(stage.stages)
			? flattenArtifactGraphStages(stage.stages)
			: []),
		...(stage.onExhausted
			? flattenArtifactGraphStages([stage.onExhausted])
			: []),
	]);
}

function parseSpecText(text: string, specPath: string): unknown {
	const extension = extname(specPath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml")
		throw new Error("YAML workflow specs are not supported; use JSON (.json).");
	return JSON.parse(text);
}

export const loadWorkflow = loadWorkflowSpec;

export function parseWorkflow(value: unknown): ArtifactGraphWorkflowSpec {
	return parseArtifactGraphWorkflowSpec(value);
}
