import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveWorkflowRef } from "../../dist/workflow-specs.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRoot = (path) => readFile(join(root, path), "utf8");

test("workflow name resolution follows documented priority and same-root ambiguity", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resolution-contract-"));
	const home = join(cwd, "home");
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const validSpec = `${JSON.stringify({ schemaVersion: 1, defaults: { agent: "scout", readOnly: true, tools: ["read"] }, artifactGraph: { stages: [{ id: "main", type: "single", prompt: "Check." }] } })}\n`;
		const shared = join(cwd, "workflows", "deep-review", "spec.json");
		const privateSpec = join(cwd, ".pi", "workflows", "deep-review", "spec.json");
		const globalSpec = join(home, ".pi", "agent", "workflows", "deep-review", "spec.json");
		for (const spec of [shared, privateSpec, globalSpec]) {
			await mkdir(dirname(spec), { recursive: true });
			await writeFile(spec, validSpec);
		}
		assert.equal((await resolveWorkflowRef("deep-review", cwd)).specPath, shared);
		await rm(dirname(shared), { recursive: true });
		assert.equal((await resolveWorkflowRef("deep-review", cwd)).specPath, privateSpec);
		await rm(dirname(privateSpec), { recursive: true });
		assert.equal((await resolveWorkflowRef("deep-review", cwd)).specPath, globalSpec);
		await rm(dirname(globalSpec), { recursive: true });
		assert.match(
			(await resolveWorkflowRef("deep-review", cwd)).specPath,
			/[/\\]workflows[/\\]deep-review[/\\]spec\.json$/,
		);

		const flat = join(cwd, "workflows", "ambiguous.json");
		const bundle = join(cwd, "workflows", "ambiguous", "spec.json");
		await mkdir(dirname(bundle), { recursive: true });
		await writeFile(flat, validSpec);
		await writeFile(bundle, validSpec);
		await assert.rejects(
			resolveWorkflowRef("ambiguous", cwd),
			/ambiguous workflow name/,
		);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("public command and troubleshooting docs mirror runtime help", async () => {
	const [usage, readme, index] = await Promise.all([
		readRoot("docs/usage.md"),
		readRoot("README.md"),
		readRoot("src/index.ts"),
	]);
	for (const command of [
		'/workflow run [--route] [--model MODEL] [--thinking LEVEL] <workflow-name-or-path> "<task>" [--detach] [--force-new]',
		'/workflow dynamic [--route] [--model MODEL] [--thinking LEVEL] "<task>" [--detach] [--force-new]',
		"/workflow show [--raw] <run-id-or-workflow-name>",
		"/workflow logs <run-id> [task-id-or-spec-id] [lines]",
	]) {
		assert.match(index, new RegExp(escapeRegExp(command)));
		assert.ok(usage.includes(command), `usage missing command: ${command}`);
	}
	assert.equal((usage.match(/\| `\/workflow stop <run-id>` \|/g) ?? []).length, 1);
	assert.match(readme, /### Diagnose a failed run/);
	assert.match(readme, /inspect <run-id> --failures --results/);
	assert.match(readme, /deep-research.*latency\/verified-coverage tradeoff/);
});

test("authoring skills describe all storage scopes and exact edge/support shapes", async () => {
	const [guide, router, usage, bundled] = await Promise.all([
		readRoot("skills/workflow-guide/SKILL.md"),
		readRoot("skills/execution-router/SKILL.md"),
		readRoot("docs/usage.md"),
		readRoot("workflows/README.md"),
	]);
	for (const text of [guide, router]) {
		assert.match(text, /project-private/);
		assert.match(text, /project-shared/);
		assert.match(text, /user\/global/);
	}
	assert.match(guide, /`single\.from`/);
	assert.match(guide, /`after` is order-only/);
	assert.match(router, /omit `type` and declare `support:/);
	assert.doesNotMatch(router, /type: single \| foreach \| reduce \| dag \| support helper/);
	assert.match(router, /`loop` and `dynamic` are supported but escalation-only/);
	assert.match(router, /do not edit the installed package bundle in place/);
	for (const text of [usage, bundled]) {
		const shared = text.indexOf("<cwd>/workflows/");
		const privateRoot = text.indexOf("<cwd>/.pi/workflows/");
		const globalRoot = text.indexOf("~/.pi/agent/workflows/");
		assert.ok(shared >= 0 && shared < privateRoot && privateRoot < globalRoot);
		assert.match(text, /shadow/i);
	}
});

test("packaged docs have self-contained speed guardrails and no stale local links", async () => {
	const [usage, packageJson, maintenance] = await Promise.all([
		readRoot("docs/usage.md"),
		readRoot("package.json").then(JSON.parse),
		readRoot("docs/maintenance/BATCHED-DA-CONTEXT-PACKET-REVIEW-20260708.md"),
	]);
	assert.match(usage, /### Speed and quality guardrails/);
	assert.doesNotMatch(usage, /\]\(speed-(?:guardrails|change-checklist)\.md\)/);
	assert.ok(packageJson.files.includes("docs/usage.md"));
	assert.match(maintenance, /Status \(historical record\)/);
	assert.match(maintenance, /do_not_merge_default_yet/);
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
