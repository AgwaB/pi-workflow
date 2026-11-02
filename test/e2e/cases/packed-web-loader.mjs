#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHook } from "node:async_hooks";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	assertArtifactFileUnchanged, assertPackedArchiveUnchanged, assertCompiledTreesEqual,
	assertCompiledTreeUnchanged, captureArtifactFile, captureCompiledTree,
	capturePackedArchive, readCompiledManifest,
} from "../compiled-artifact-proof.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const consumerRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-workflow-packed-web-loader-")));
const packDir = join(consumerRoot, "pack");
const unpackDir = join(consumerRoot, "consumer");
const packageRoot = join(unpackDir, "package");
const isolatedRoots = join(consumerRoot, "isolated-roots");
const home = join(isolatedRoots, "home");
const agentDir = join(isolatedRoots, "pi-agent");
const xdgConfig = join(isolatedRoots, "xdg-config");
const xdgCache = join(isolatedRoots, "xdg-cache");
const xdgData = join(isolatedRoots, "xdg-data");
const xdgState = join(isolatedRoots, "xdg-state");
mkdirSync(packDir, { recursive: true });
mkdirSync(unpackDir, { recursive: true });
for (const path of [home, agentDir, xdgConfig, xdgCache, xdgData, xdgState]) {
	mkdirSync(path, { recursive: true });
}
Object.assign(process.env, {
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	XDG_CONFIG_HOME: xdgConfig,
	XDG_CACHE_HOME: xdgCache,
	XDG_DATA_HOME: xdgData,
	XDG_STATE_HOME: xdgState,
});

try {
	assert.ok(process.env.PI_WORKFLOW_E2E_PROCESS_LOG, "packed proof requires the original E2E evidence directory");
	const evidenceDir = dirname(process.env.PI_WORKFLOW_E2E_PROCESS_LOG);
	const compileManifestPath = join(evidenceDir, "compiled-artifacts.json");
	const compileManifest = readCompiledManifest(compileManifestPath, join(sourceRoot, ".tmp", "unit"));
	const sourceDist = captureCompiledTree(join(sourceRoot, "dist"));
	const sourceInputs = Object.fromEntries(["package.json", "tsconfig.json"].map(name => {
		const captured = captureArtifactFile(join(sourceRoot, name));
		return [name, { size: captured.size, sha256: captured.sha256, identity: captured.identity }];
	}));
	assertCompiledTreesEqual(compileManifest.tree, sourceDist);
	const packOutput = execFileSync(
		"npm",
		["pack", "--pack-destination", packDir, "--silent", "--ignore-scripts"],
		{
			cwd: sourceRoot,
			encoding: "utf8",
			timeout: 180_000,
			maxBuffer: 8 * 1024 * 1024,
			env: {
				...process.env,
				npm_config_offline: "true",
				npm_config_audit: "false",
				npm_config_fund: "false",
				npm_config_update_notifier: "false",
			},
		},
	);
	const archive = capturePackedArchive(packDir, packOutput);
	assertPackedArchiveUnchanged(archive.path, archive);
	execFileSync("tar", ["-xzf", archive.path, "-C", unpackDir], {
		cwd: consumerRoot,
		timeout: 60_000,
	});
	assertPackedArchiveUnchanged(archive.path, archive);
	const packedDist = captureCompiledTree(join(packageRoot, "dist"));
	assertCompiledTreesEqual(compileManifest.tree, packedDist);
	assertCompiledTreeUnchanged(sourceDist);
	assertArtifactFileUnchanged(compileManifestPath, compileManifest);
	assert.ok(existsSync(join(packageRoot, "node_modules", "pi-web-access", "storage.ts")));

	// A tarball consumer supplies the package's required Pi peer. Link the local
	// already-installed peer scope without running any package installation.
	const packedPeerScope = join(packageRoot, "node_modules", "@earendil-works");
	mkdirSync(packedPeerScope, { recursive: true });
	for (const packageName of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
		symlinkSync(
			join(sourceRoot, "node_modules", "@earendil-works", packageName),
			join(packedPeerScope, packageName),
			"dir",
		);
	}
	for (const packageName of ["typebox", "ssh2"]) {
		const target = join(packageRoot, "node_modules", packageName);
		if (!existsSync(target)) {
			symlinkSync(join(sourceRoot, "node_modules", packageName), target, "dir");
		}
	}

	const consumerProject = join(consumerRoot, "project");
	const consumerScope = join(consumerProject, "node_modules", "@agwab");
	const consumerBin = join(consumerProject, "node_modules", ".bin");
	mkdirSync(consumerScope, { recursive: true });
	mkdirSync(consumerBin, { recursive: true });
	writeFileSync(
		join(consumerProject, "package.json"),
		`${JSON.stringify({ name: "packed-consumer", private: true, type: "module" }, null, 2)}\n`,
	);
	symlinkSync(packageRoot, join(consumerScope, "pi-workflow"), "dir");
	symlinkSync(
		join(packageRoot, "src", "cli.mjs"),
		join(consumerBin, "pi-workflow"),
		"file",
	);

	const networkResources = [];
	let loadedToolExecutions = 0;
	const networkHook = createHook({
		init(_asyncId, type) {
			if (
				/^(?:TCPWRAP|TCPCONNECTWRAP|TLSWRAP|GETADDRINFOREQWRAP|HTTPCLIENTREQUEST)$/.test(
					type,
				)
			) {
				networkResources.push(type);
			}
		},
	});
	networkHook.enable();
	try {
		const [{ DefaultResourceLoader }, fetchAdapter, webSourceAdapter] =
			await Promise.all([
				import("@earendil-works/pi-coding-agent"),
				import(
					pathToFileURL(
						join(packageRoot, "dist", "workflow-fetch-cache-extension.js"),
					).href
				),
				import(
					pathToFileURL(
						join(packageRoot, "dist", "workflow-web-source-extension.js"),
					).href
				),
			]);
		const providerPath = join(
			packageRoot,
			"node_modules",
			"pi-web-access",
			"index.ts",
		);
		const storagePath = join(
			packageRoot,
			"node_modules",
			"pi-web-access",
			"storage.ts",
		);
		const fetchAdapterPath = join(
			packageRoot,
			"dist",
			"workflow-fetch-cache-extension.js",
		);
		const webSourceAdapterPath = join(
			packageRoot,
			"dist",
			"workflow-web-source-extension.js",
		);

		const scenarios = [
			{
				name: "legacy",
				kinds: ["legacy"],
				expectedTools: ["fetch_content"],
				expectedHandlerGroups: 3,
			},
			{
				name: "normalized",
				kinds: ["normalized"],
				expectedTools: ["workflow_web_search", "workflow_web_source_read"],
				expectedHandlerGroups: 0,
			},
			{
				name: "mixed",
				kinds: ["legacy", "normalized"],
				expectedTools: [
					"fetch_content",
					"workflow_web_search",
					"workflow_web_source_read",
				],
				expectedHandlerGroups: 3,
			},
		];

		for (const scenario of scenarios) {
			const scenarioRoot = join(consumerRoot, "scenarios", scenario.name);
			mkdirSync(scenarioRoot, { recursive: true });
			const extensionPaths = [];
			if (scenario.kinds.includes("legacy")) {
				const wrapperPath = join(scenarioRoot, "legacy-wrapper.ts");
				writeFileSync(
					wrapperPath,
					fetchAdapter.buildWorkflowFetchCacheExtensionWrapper({
						importPath: fetchAdapterPath,
						webAccessExtensionPath: providerPath,
						webAccessStoragePath: storagePath,
						config: {
							runId: `packed-${scenario.name}`,
							taskId: "task",
							cacheDir: join(scenarioRoot, "legacy-cache"),
							cacheEnabled: false,
							requiredProviderTools: ["fetch_content"],
							exposedProviderTools: ["fetch_content"],
						},
					}),
				);
				extensionPaths.push(wrapperPath);
			}
			if (scenario.kinds.includes("normalized")) {
				const wrapperPath = join(scenarioRoot, "normalized-wrapper.ts");
				writeFileSync(
					wrapperPath,
					webSourceAdapter.buildWorkflowWebSourceExtensionWrapper({
						importPath: webSourceAdapterPath,
						providerExtensionPath: providerPath,
						config: {
							schema: "workflow-web-source-launch-config-v1",
							runId: `packed-${scenario.name}`,
							taskId: "task",
							cwd: scenarioRoot,
							cacheDir: join(scenarioRoot, "normalized-cache"),
							provider: { kind: "pi-web-access" },
							securityPolicy: {
								allowPrivateHosts: false,
								cacheRawProviderPayloads: false,
							},
							exposedWorkflowTools: [
								"workflow_web_search",
								"workflow_web_source_read",
							],
							requiredProviderTools: ["web_search"],
						},
					}),
				);
				extensionPaths.push(wrapperPath);
			}

			const loader = new DefaultResourceLoader({
				cwd: scenarioRoot,
				agentDir,
				additionalExtensionPaths: extensionPaths,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			assert.deepEqual(
				loaded.errors,
				[],
				`${scenario.name} loader errors/collisions: ${JSON.stringify(loaded.errors)}`,
			);
			const toolNames = loaded.extensions
				.flatMap((extension) => [...extension.tools.keys()])
				.sort();
			assert.deepEqual(toolNames, scenario.expectedTools.toSorted());
			assert.equal(new Set(toolNames).size, toolNames.length, "tool collision");
			assert.equal(toolNames.includes("source_check"), false);
			assert.equal(
				loaded.extensions.reduce(
					(total, extension) => total + extension.handlers.size,
					0,
				),
				scenario.expectedHandlerGroups,
			);
			assert.equal(
				loaded.extensions.reduce(
					(total, extension) => total + extension.commands.size,
					0,
				),
				0,
			);
			assert.equal(
				loaded.extensions.reduce(
					(total, extension) => total + extension.shortcuts.size,
					0,
				),
				0,
			);
			for (const extension of loaded.extensions) {
				for (const tool of extension.tools.values()) {
					if (typeof tool.execute !== "function") continue;
					const execute = tool.execute.bind(tool);
					tool.execute = (...args) => {
						loadedToolExecutions += 1;
						const processLog = process.env.PI_WORKFLOW_E2E_PROCESS_LOG;
						if (processLog) {
							appendFileSync(
								processLog,
								`${JSON.stringify({ type: "provider-tool-execution", at: new Date().toISOString(), pid: process.pid, tool: tool.name })}\n`,
							);
						}
						return execute(...args);
					};
				}
			}
		}

		const consumerRequire = createRequire(join(consumerProject, "package.json"));
		const workflowPackagePath = consumerRequire.resolve(
			"@agwab/pi-workflow/package.json",
		);
		assert.equal(
			realpathSync(workflowPackagePath),
			realpathSync(join(packageRoot, "package.json")),
		);
		const publicApi = await import(
			pathToFileURL(consumerRequire.resolve("@agwab/pi-workflow")).href
		);
		assert.equal(typeof publicApi.parseWorkflow, "function");
		assert.equal(publicApi.WORKFLOW_COMMAND, "workflow");

		const subagentPackage = consumerRequire(
			join(packageRoot, "node_modules", "@agwab", "pi-subagent", "package.json"),
		);
		assert.equal(subagentPackage.version, "0.7.2");
		const subagentRequire = createRequire(
			join(packageRoot, "node_modules", "@agwab", "pi-subagent", "package.json"),
		);
		const subagentApi = await import(
			pathToFileURL(subagentRequire.resolve("@agwab/pi-subagent/api")).href
		);
		for (const name of [
			"createDurableLaunchBarrierV2",
			"durableLaunchBarrierDigest",
			"waitForDurableLaunchBarrierV2Ready",
			"resolveDurableLaunchBarrierV2Release",
			"revokeDurableLaunchBarrierV2",
			"readDurableLaunchBarrierV2State",
			"waitForDurableLaunchBarrierV2Ack",
			"pruneSubagentRuns",
			"supportsExplicitExtensionIsolation",
		]) {
			assert.equal(typeof subagentApi[name], "function", `missing bundled API ${name}`);
		}
		assert.equal(subagentApi.supportsExplicitExtensionIsolation(), true);

		execFileSync(process.execPath, [join(packageRoot, "src", "cli.mjs"), "--help"], {
			cwd: consumerProject,
			stdio: "pipe",
			env: process.env,
		});
		execFileSync(join(consumerBin, "pi-workflow"), ["--help"], {
			cwd: consumerProject,
			stdio: "pipe",
			env: process.env,
		});
		execFileSync(
			process.execPath,
			[
				join(sourceRoot, "test", "e2e", "cases", "packed-workflows.mjs"),
				packageRoot,
				consumerProject,
			],
			{ cwd: consumerProject, stdio: "pipe", env: process.env },
		);
	} finally {
		networkHook.disable();
	}
	assert.deepEqual(networkResources, [], "packed loader attempted network activity");
	assert.equal(loadedToolExecutions, 0, "packed loader executed a provider/tool implementation");
	for (const snapshot of [compileManifest.tree, sourceDist, packedDist]) assertCompiledTreeUnchanged(snapshot);
	assertArtifactFileUnchanged(compileManifestPath, compileManifest);
	assertPackedArchiveUnchanged(archive.path, archive);
	for (const [name, captured] of Object.entries(sourceInputs)) assertArtifactFileUnchanged(join(sourceRoot, name), captured);
	writeFileSync(join(evidenceDir, "packed-dist-correspondence.json"), `${JSON.stringify({
		schema: "packed-dist-correspondence-v1", distOnly: true,
		compileManifest: { sha256: compileManifest.sha256, size: compileManifest.size, identity: compileManifest.identity },
		compiled: compileManifest.tree, sourceDist, packedDist, archive, sourceInputs,
	})}\n`, { flag: "wx", mode: 0o600 });
	console.log("validated no-install packed consumer plus legacy, normalized, and mixed real-Pi wrappers");
} finally {
	rmSync(consumerRoot, { recursive: true, force: true });
}
