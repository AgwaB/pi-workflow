import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
	createArtifactGraphRuntimeValidationSnapshot,
	executeSupportTask,
} from "../../.tmp/unit/artifact-graph-runtime.js";
import { compileWorkflow } from "../../.tmp/unit/compiler.js";
import { buildForeachGeneratedTasks } from "../../.tmp/unit/engine-run-graph.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import {
	createWorkflowRunRecord,
	fromProjectPath,
	writeRunRecord,
	writeStaticRunArtifacts,
} from "../../.tmp/unit/store.js";
import { writeWorkflowTaskArtifactBundle } from "../../.tmp/unit/workflow-output-artifacts.js";
import {
	BINDING_VERSION,
	initializeFixedInventoryBundle,
	MAX_BINDING_BYTES,
	OUTPUT_FILES,
	readFixedInventoryBindingFile,
	validateFixedInventoryBinding,
} from "../../skills/workflow-guide/scaffolds/fixed-inventory/initialize.mjs";
import fixedInventoryPipeline from "../../skills/workflow-guide/scaffolds/fixed-inventory/helpers/pipeline.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scaffoldRoot = join(
	root,
	"skills/workflow-guide/scaffolds/fixed-inventory",
);
const initializer = join(scaffoldRoot, "initialize.mjs");

function binding() {
	return {
		name: "proposal-questions",
		description:
			"Draft stakeholder questions for the approved proposal documents.",
		items: [
			{ id: "proposal", path: "docs/proposal.md" },
			{ id: "rollout", path: "docs/rollout.md" },
		],
	};
}

async function schema(bundleRoot, kind) {
	return JSON.parse(
		await readFile(join(bundleRoot, `schemas/${kind}-control.schema.json`), "utf8"),
	);
}

async function assertSchemaValid(value, bundleRoot, kind) {
	const result = validateJsonSchema(value, await schema(bundleRoot, kind));
	assert.equal(result.valid, true, JSON.stringify(result.issues));
}

async function loadBundle(bundleRoot, cwd = root) {
	const specPath = join(bundleRoot, "spec.json");
	const loaded = await loadWorkflowSpec(specPath, cwd);
	const compiled = await compileWorkflow(loaded.spec, {
		cwd,
		specPath: loaded.specPath,
		task: "Draft stakeholder questions for the approved documents only.",
	});
	assert.deepEqual(compiled.warnings, []);
	return { ...loaded, compiled };
}

async function bundleBytes(bundleRoot) {
	return await Promise.all(
		OUTPUT_FILES.map(async (relativePath) => [
			relativePath,
			await readFile(join(bundleRoot, ...relativePath.split("/")), "utf8"),
		]),
	);
}

function pipelineInput(items = binding().items) {
	const inventory = {
		schema: "fixed-inventory-v1",
		items: items.map(({ id, path }) => ({ id, path })),
	};
	const sourceStatuses = [
		{
			source: "inventory",
			stageId: "inventory",
			specId: "inventory.main",
			taskId: "inventory-task",
			status: "completed",
		},
	];
	const sources = { inventory };
	for (const [index, item] of items.entries()) {
		const source = `questions.${item.id}`;
		sourceStatuses.push({
			source,
			stageId: "questions",
			specId: `questions.${item.id}`,
			taskId: `worker-${index + 1}`,
			status: "completed",
			itemIdentity: item.id,
			placeholderSpecId: "questions.item",
		});
		sources[source] = {
			schema: "fixed-item-v1",
			digest: "Editorial questions only; no facts were certified.",
			...item,
			documentStatus: "read",
			questions: ["Who owns the next decision?"],
			limitations: [],
		};
	}
	return {
		sources,
		context: { sourceStatuses },
		options: { mode: "final" },
	};
}

async function makeTemp(t, prefix) {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

test("fixed-inventory initializer binds a deterministic provider-free bundle", async (t) => {
	for (const relativePath of [
		"initialize.mjs",
		"helpers/exact-source-join.mjs",
		"helpers/pipeline.mjs",
	]) {
		const source = await readFile(join(scaffoldRoot, relativePath), "utf8");
		assert.doesNotMatch(
			source,
			/@agwab\/pi-subagent|pi-coding-agent|node:(?:child_process|http|https|net|tls)|\bfetch\s*\(/,
			relativePath,
		);
	}
	const temp = await makeTemp(t, "fixed-inventory-initialize-");
	const first = join(temp, "first");
	const second = join(temp, "second");
	await mkdir(second);
	const firstResult = await initializeFixedInventoryBundle(binding(), first);
	await initializeFixedInventoryBundle(binding(), second);
	assert.equal(firstResult.version, BINDING_VERSION);
	assert.deepEqual(firstResult.files, [...OUTPUT_FILES]);
	assert.deepEqual(await bundleBytes(first), await bundleBytes(second));

	const { spec, compiled } = await loadBundle(first);
	assert.equal(spec.name, binding().name);
	assert.equal(spec.description, binding().description);
	assert.deepEqual(
		spec.artifactGraph.stages.map(({ id, type, support, profileRole }) => ({
			id,
			type,
			support: Boolean(support),
			profileRole,
		})),
		[
			{ id: "inventory", type: undefined, support: true, profileRole: undefined },
			{
				id: "questions",
				type: "foreach",
				support: false,
				profileRole: "research-execution",
			},
			{ id: "final", type: undefined, support: true, profileRole: undefined },
		],
	);
	const inventoryStage = spec.artifactGraph.stages[0];
	const questionStage = spec.artifactGraph.stages[1];
	assert.deepEqual(inventoryStage.support.options.items, binding().items);
	assert.equal(questionStage.maxItems, 8);
	assert.equal(questionStage.each.itemIdentityPath, "$.id");
	assert.deepEqual(spec.defaults.tools, ["read"]);
	assert.equal(spec.defaults.readOnly, true);
	assert.equal(spec.defaults.agent, "scout");
	const modelTasks = compiled.tasks.filter((task) => !task.support);
	assert.equal(modelTasks.length, 1);
	assert.deepEqual(modelTasks[0].runtime.tools, ["read"]);
	assert.equal(modelTasks[0].safety.readOnlyDeclared, true);

	const inventory = fixedInventoryPipeline({
		options: inventoryStage.support.options,
	});
	await assertSchemaValid(inventory, first, "inventory");
	const generated = buildForeachGeneratedTasks(
		modelTasks[0],
		"Draft questions only.",
		inventory.items,
	);
	assert.equal(generated.error, undefined);
	assert.deepEqual(
		generated.tasks.map((task) => task.foreachGenerated.itemIdentity),
		binding().items.map(({ id }) => id),
	);
	assert.match(generated.tasks[0].compiledPrompt, /docs\/proposal\.md/);
	assert.doesNotMatch(generated.tasks[0].compiledPrompt, /docs\/rollout\.md/);
	assert.match(generated.tasks[1].compiledPrompt, /docs\/rollout\.md/);
	assert.doesNotMatch(generated.tasks[1].compiledPrompt, /docs\/proposal\.md/);

	const promptExample = questionStage.each.prompt.match(
		/Example control: <control>(.*?)<\/control>/s,
	);
	assert.ok(promptExample);
	const example = JSON.parse(promptExample[1]);
	await assertSchemaValid(example, first, "item");
	assert.equal(
		validateJsonSchema(
			{ ...example, extra: "forbidden" },
			await schema(first, "item"),
		).valid,
		false,
	);
});

test("fixed-inventory initializer validates before mutation and never clobbers", async (t) => {
	const temp = await makeTemp(t, "fixed-inventory-guard-");
	const inherited = Object.create(binding());
	const invalid = [
		{ ...binding(), unexpected: true },
		inherited,
		{ ...binding(), name: "Bad Name" },
		{ ...binding(), name: "trailing-" },
		{ ...binding(), description: "   " },
		{ ...binding(), description: "hidden\u001b[31m" },
		{ ...binding(), description: "reversed\u202etext" },
		{ ...binding(), items: [] },
		{
			...binding(),
			items: [
				{ id: "same", path: "docs/a.md" },
				{ id: "same", path: "docs/b.md" },
			],
		},
		{ ...binding(), items: [{ id: "escape", path: "../secret" }] },
		{ ...binding(), items: [{ id: "absolute", path: "/tmp/secret" }] },
		{
			...binding(),
			items: Array.from({ length: 9 }, (_, index) => ({
				id: `doc-${index}`,
				path: `docs/doc-${index}.md`,
			})),
		},
	];
	for (const [index, candidate] of invalid.entries()) {
		const target = join(temp, `invalid-${index}`);
		assert.throws(() => validateFixedInventoryBinding(candidate));
		await assert.rejects(initializeFixedInventoryBundle(candidate, target));
		await assert.rejects(readFile(join(target, "spec.json"), "utf8"), {
			code: "ENOENT",
		});
	}

	const nonempty = join(temp, "nonempty");
	await mkdir(nonempty);
	await writeFile(join(nonempty, "sentinel.txt"), "keep exact\n");
	await assert.rejects(
		initializeFixedInventoryBundle(binding(), nonempty),
		/absent or empty/,
	);
	assert.deepEqual(await readdir(nonempty), ["sentinel.txt"]);
	assert.equal(await readFile(join(nonempty, "sentinel.txt"), "utf8"), "keep exact\n");

	const initialized = join(temp, "initialized");
	await initializeFixedInventoryBundle(binding(), initialized);
	const before = await bundleBytes(initialized);
	await assert.rejects(
		initializeFixedInventoryBundle(
			{ ...binding(), description: "Do not overwrite." },
			initialized,
		),
		/absent or empty/,
	);
	assert.deepEqual(await bundleBytes(initialized), before);

	const realDestination = join(temp, "real-destination");
	const linkedDestination = join(temp, "linked-destination");
	await mkdir(realDestination);
	await symlink(realDestination, linkedDestination);
	await assert.rejects(
		initializeFixedInventoryBundle(binding(), linkedDestination),
		/destination cannot be a symlink/,
	);
	assert.deepEqual(await readdir(realDestination), []);

	const bindingFile = join(temp, "binding.json");
	await writeFile(bindingFile, JSON.stringify(binding()));
	assert.deepEqual(await readFixedInventoryBindingFile(bindingFile), binding());
	const linkedBinding = join(temp, "linked-binding.json");
	await symlink(bindingFile, linkedBinding);
	await assert.rejects(
		readFixedInventoryBindingFile(linkedBinding),
		/binding file cannot be a symlink/,
	);
	const malformed = join(temp, "malformed.json");
	await writeFile(malformed, "{");
	await assert.rejects(readFixedInventoryBindingFile(malformed), /not valid JSON/);
	const oversized = join(temp, "oversized.json");
	await writeFile(oversized, " ".repeat(MAX_BINDING_BYTES + 1));
	await assert.rejects(
		readFixedInventoryBindingFile(oversized),
		/exceeds 65536 bytes/,
	);

	const cliTarget = join(temp, "cli");
	const cli = await execFileAsync(
		process.execPath,
		[initializer, bindingFile, cliTarget],
		{ cwd: root },
	);
	assert.match(cli.stdout, /Initialized fixed-inventory-binding-v1/);
	await loadBundle(cliTarget);
	await assert.rejects(
		execFileAsync(process.execPath, [initializer, bindingFile, cliTarget], {
			cwd: root,
		}),
		/absent or empty/,
	);
});

for (const degraded of [false, true]) {
	test(`fixed-inventory helpers publish through the current runtime (degraded=${degraded})`, async (t) => {
		const cwd = await makeTemp(t, "fixed-inventory-runtime-");
		const bundleRoot = join(cwd, "bundle");
		await initializeFixedInventoryBundle(binding(), bundleRoot);
		const { spec, specPath, compiled } = await loadBundle(bundleRoot, cwd);
		const inventoryStage = spec.artifactGraph.stages[0];
		const generatedPipeline = (
			await import(
				`${pathToFileURL(join(bundleRoot, "helpers/pipeline.mjs")).href}?runtime=${degraded}`
			)
		).default;
		const inventory = generatedPipeline({
			options: inventoryStage.support.options,
		});
		const templateIndex = compiled.tasks.findIndex((task) => task.foreach);
		const generated = buildForeachGeneratedTasks(
			compiled.tasks[templateIndex],
			"Questions only.",
			inventory.items,
		);
		assert.equal(generated.error, undefined);
		compiled.tasks.splice(templateIndex, 1, ...generated.tasks);
		const inventoryCompiled = compiled.tasks.find(
			(task) => task.stageId === "inventory",
		);
		const finalCompiled = compiled.tasks.find((task) => task.stageId === "final");
		assert.ok(inventoryCompiled && finalCompiled);
		finalCompiled.dependsOn = [
			inventoryCompiled.id,
			...generated.tasks.map((task) => task.id),
		];

		const { run } = await createWorkflowRunRecord(cwd, compiled, specPath);
		await writeStaticRunArtifacts(cwd, run, compiled, spec);
		await writeRunRecord(cwd, run);
		const inventoryTask = run.tasks.find((task) => task.stageId === "inventory");
		assert.ok(inventoryTask);
		assert.equal(
			await executeSupportTask(
				cwd,
				run,
				inventoryTask,
				inventoryCompiled,
				createArtifactGraphRuntimeValidationSnapshot(run),
			),
			true,
		);
		const emittedInventory = JSON.parse(
			await readFile(
				join(
					dirname(fromProjectPath(cwd, inventoryTask.files.result)),
					"control.json",
				),
				"utf8",
			),
		);
		assert.deepEqual(emittedInventory, inventory);
		await assertSchemaValid(emittedInventory, bundleRoot, "inventory");

		const workers = run.tasks.filter((task) => task.foreachGenerated);
		assert.equal(workers.length, binding().items.length);
		for (const [index, task] of workers.entries()) {
			const control = {
				schema: "fixed-item-v1",
				digest: "Question extraction only; no factual verdict.",
				...inventory.items[index],
				documentStatus: degraded && index === 0 ? "partial" : "read",
				questions: ["Who owns this decision?"],
				limitations: [],
			};
			await assertSchemaValid(control, bundleRoot, "item");
			const written = await writeWorkflowTaskArtifactBundle({
				taskDir: dirname(fromProjectPath(cwd, task.files.result)),
				rawOutput: `<control>${JSON.stringify(control)}</control>\n<analysis>Editorial questions only.</analysis>\n<refs>[]</refs>`,
				controlJsonSchema: await schema(bundleRoot, "item"),
			});
			assert.equal(written.valid, true);
			task.status = "completed";
			task.statusDetail = "completed";
		}

		const finalTask = run.tasks.find((task) => task.stageId === "final");
		assert.ok(finalTask);
		const published = await executeSupportTask(
			cwd,
			run,
			finalTask,
			finalCompiled,
			createArtifactGraphRuntimeValidationSnapshot(run),
		);
		assert.equal(published, !degraded);
		assert.equal(finalTask.status, degraded ? "failed" : "completed");
		const finalDirectory = dirname(
			fromProjectPath(cwd, finalTask.files.result),
		);
		const control = JSON.parse(
			await readFile(join(finalDirectory, "control.json"), "utf8"),
		);
		await assertSchemaValid(control, bundleRoot, "final");
		assert.equal(control.status, finalTask.status);
		assert.equal(
			await readFile(join(finalDirectory, "analysis.md"), "utf8"),
			`${control.executiveMarkdown}\n`,
		);
		assert.equal((await readdir(finalDirectory)).includes("final-report.md"), false);
		assert.deepEqual(
			control.rows.map((row) => row.owner.taskId),
			workers.map((task) => task.taskId),
		);
		assert.deepEqual(
			control.rows.map(({ id, path }) => ({ id, path })),
			binding().items,
		);
	});
}

test("fixed-inventory exact joins preserve gaps and reject ambiguous ownership", async () => {
	const complete = pipelineInput();
	const output = fixedInventoryPipeline(complete);
	await assertSchemaValid(output, scaffoldRoot, "final");
	assert.equal(output.status, "completed");
	assert.equal(output.coverage, "complete");
	assert.deepEqual(output.acceptedIds, ["proposal", "rollout"]);
	assert.deepEqual(
		output.rows.map(({ id, path }) => ({ id, path })),
		binding().items,
	);

	const missing = pipelineInput();
	delete missing.sources["questions.rollout"];
	missing.context.sourceStatuses = missing.context.sourceStatuses.filter(
		(status) => status.itemIdentity !== "rollout",
	);
	const partial = fixedInventoryPipeline(missing);
	await assertSchemaValid(partial, scaffoldRoot, "final");
	assert.equal(partial.status, "failed");
	assert.equal(partial.coverage, "partial");
	assert.deepEqual(partial.missingIds, ["rollout"]);
	assert.deepEqual(
		partial.rows.map(({ id, availability }) => ({ id, availability })),
		[
			{ id: "proposal", availability: "accepted" },
			{ id: "rollout", availability: "unavailable" },
		],
	);
	assert.ok(
		partial.issues.some(({ code }) => code === "missing-or-duplicate-item"),
	);

	const failed = pipelineInput();
	failed.context.sourceStatuses[1].status = "failed";
	delete failed.sources["questions.proposal"];
	const failedOutput = fixedInventoryPipeline(failed);
	assert.equal(failedOutput.status, "failed");
	assert.ok(
		failedOutput.issues.some(({ code }) => code === "unavailable-worker"),
	);

	const duplicate = pipelineInput();
	duplicate.context.sourceStatuses.push({
		...duplicate.context.sourceStatuses[1],
		source: "questions.proposal-copy",
		taskId: "worker-copy",
		specId: "questions.proposal",
	});
	duplicate.sources["questions.proposal-copy"] = {
		...duplicate.sources["questions.proposal"],
	};
	const duplicateOutput = fixedInventoryPipeline(duplicate);
	assert.equal(duplicateOutput.status, "failed");
	assert.ok(
		duplicateOutput.issues.some(({ code }) => code === "duplicate-owner"),
	);

	const unexpected = pipelineInput();
	unexpected.context.sourceStatuses.push({
		...unexpected.context.sourceStatuses[1],
		source: "questions.alien",
		itemIdentity: "alien",
		taskId: "worker-alien",
		specId: "questions.alien",
	});
	unexpected.sources["questions.alien"] = {
		...unexpected.sources["questions.proposal"],
		id: "alien",
		path: "docs/alien.md",
	};
	const unexpectedOutput = fixedInventoryPipeline(unexpected);
	assert.equal(unexpectedOutput.status, "failed");
	assert.ok(unexpectedOutput.issues.some(({ code }) => code === "extra-item"));

	const mismatched = pipelineInput();
	mismatched.sources["questions.proposal"].path = "docs/other.md";
	const mismatchedOutput = fixedInventoryPipeline(mismatched);
	assert.equal(mismatchedOutput.status, "failed");
	assert.ok(
		mismatchedOutput.issues.some(({ code }) => code === "mismatched-control"),
	);

	const completedWithoutControl = pipelineInput();
	delete completedWithoutControl.sources["questions.proposal"];
	const missingControlOutput = fixedInventoryPipeline(completedWithoutControl);
	assert.equal(missingControlOutput.status, "failed");
	assert.ok(
		missingControlOutput.issues.some(({ code }) => code === "unavailable-worker"),
	);

	const noInventoryOwner = pipelineInput();
	noInventoryOwner.context.sourceStatuses.shift();
	const noInventoryOutput = fixedInventoryPipeline(noInventoryOwner);
	assert.equal(noInventoryOutput.status, "failed");
	assert.ok(
		noInventoryOutput.issues.some(({ code }) => code === "inventory-owner"),
	);
});

test("fixed-inventory rendering escapes untrusted text and blocks overflow", async () => {
	const unsafe = pipelineInput([binding().items[0]]);
	unsafe.sources["questions.proposal"].digest =
		"[digest](javascript:alert(1)) <b>not markup</b>";
	unsafe.sources["questions.proposal"].questions = [
		"[click](javascript:alert(1)) <script>alert(1)</script>\n# injected heading",
	];
	unsafe.sources["questions.proposal"].limitations = [
		"`code` | table | ![image](https://example.invalid/x)",
	];
	const rendered = fixedInventoryPipeline(unsafe);
	await assertSchemaValid(rendered, scaffoldRoot, "final");
	assert.match(rendered.executiveMarkdown, /^# Document questions/m);
	assert.doesNotMatch(rendered.executiveMarkdown, /<script>|<b>|javascript:/i);
	assert.doesNotMatch(rendered.executiveMarkdown, /\n# injected heading/);
	assert.doesNotMatch(rendered.executiveMarkdown, /!\[image\]\(https:/);
	assert.match(rendered.executiveMarkdown, /&#58;/);
	assert.match(rendered.executiveMarkdown, /&#60;script&#62;/);

	const items = Array.from({ length: 8 }, (_, index) => ({
		id: `document-${index}`,
		path: `docs/document-${index}.md`,
	}));
	const overflowing = pipelineInput(items);
	for (const item of items) {
		overflowing.sources[`questions.${item.id}`].questions = Array.from(
			{ length: 6 },
			() => ":".repeat(500),
		);
		overflowing.sources[`questions.${item.id}`].limitations = Array.from(
			{ length: 8 },
			() => ":".repeat(500),
		);
	}
	assert.throws(
		() => fixedInventoryPipeline(overflowing),
		/render exceeds 128 KiB/,
	);
});
