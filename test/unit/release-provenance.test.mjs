import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { verifyNpmPublication } from "../../tools/release/verify-npm-publication.mjs";

const verifier = new URL("../../tools/release/verify-npm-publication.mjs", import.meta.url).pathname;
const name = "@agwab/pi-workflow";
const version = "0.12.0";
const commit = "0123456789abcdef0123456789abcdef01234567";
const purl = `pkg:npm/%40agwab/pi-workflow@${version}`;
const registry = "https://registry.npmjs.org";

function envelope(dist) {
	return { name, version, dist };
}
function dist(integrity, signatures = [{ keyid: "fixture-key", sig: "fixture-signature" }]) {
	return {
		integrity, shasum: "fixture-sha", tarball: `${registry}/@agwab/pi-workflow/-/pi-workflow-${version}.tgz`,
		fileCount: 1, unpackedSize: 1,
		attestations: { url: `${registry}/-/npm/v1/attestations/@agwab%2fpi-workflow@${version}`, provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
		signatures,
	};
}
function statement(payload, predicateType) {
	return {
		predicateType,
		bundle: {
			mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
			verificationMaterial: { tlogEntries: [{}] },
			dsseEnvelope: { payload: Buffer.from(JSON.stringify(payload)).toString("base64"), payloadType: "application/vnd.in-toto+json", signatures: [{ sig: "fixture-dsse-signature", keyid: "fixture-key" }] },
		},
		signedAccessSignatureUrl: "",
	};
}
function subjects(digest) { return [{ name: purl, digest: { sha512: digest } }]; }
function audit(digest, overrides = {}) {
	const repo = "https://github.com/AgwaB/pi-workflow";
	const slsa = {
		_type: "https://in-toto.io/Statement/v1", subject: subjects(digest), predicateType: "https://slsa.dev/provenance/v1",
		predicate: {
			buildDefinition: {
				buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
				externalParameters: { workflow: { ref: "refs/heads/main", repository: repo, path: ".github/workflows/publish.yml" } },
				internalParameters: { github: { event_name: "workflow_dispatch", repository_id: "1", repository_owner_id: "2" } },
				resolvedDependencies: [{ uri: `${"git+"}${repo}@refs/heads/main`, digest: { gitCommit: commit } }],
			},
			runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" }, metadata: { invocationId: `${repo}/actions/runs/1/attempts/1` } },
		},
	};
	const publish = { _type: "https://in-toto.io/Statement/v0.1", subject: subjects(digest), predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1", predicate: { name, version, registry } };
	const record = { name, version, location: `node_modules/${name}`, registry: `${registry}/`, attestations: { url: `${registry}/-/npm/v1/attestations/@agwab%2fpi-workflow@${version}`, provenance: { predicateType: "https://slsa.dev/provenance/v1" } }, attestationBundles: [statement(publish, publish.predicateType), statement(slsa, slsa.predicateType)] };
	return { invalid: [], missing: [], verified: [Object.assign(record, overrides)] };
}

async function runFixture(mutate, after = "valid", { fetchImpl, verifierOptions = {}, registrySignatures } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-release-provenance-"));
	try {
		const bytes = Buffer.from("offline release artifact fixture\n");
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		await writeFile(join(cwd, "package.tgz"), bytes);
		await writeFile(join(cwd, "before.json"), JSON.stringify(envelope(null)));
		await writeFile(join(cwd, "after.json"), JSON.stringify(after === "single-field" ? { dist: dist(integrity, registrySignatures) } : envelope(dist(integrity, registrySignatures))));
		await writeFile(join(cwd, "tags.json"), JSON.stringify({ latest: version }));
		const evidence = audit(createHash("sha512").update(bytes).digest("hex"));
		mutate(evidence);
		await writeFile(join(cwd, "audit.json"), JSON.stringify(evidence));
		const paths = {
			packagePath: join(cwd, "package.tgz"),
			beforePath: join(cwd, "before.json"),
			afterPath: join(cwd, "after.json"),
			tagsPath: join(cwd, "tags.json"),
			auditPath: join(cwd, "audit.json"),
		};
		const env = { NPM_PACKAGE: name, TARGET_VERSION: version, EXPECTED_REPOSITORY: "AgwaB/pi-workflow", EXPECTED_WORKFLOW_REF: "refs/heads/main", EXPECTED_WORKFLOW_PATH: ".github/workflows/publish.yml", RELEASE_COMMIT: commit };
		if (fetchImpl) {
			const output = await verifyNpmPublication({ ...paths, env, fetchImpl, ...verifierOptions });
			return { status: 0, output };
		}
		return spawnSync(process.execPath, [verifier, paths.packagePath, paths.beforePath, paths.afterPath, paths.tagsPath, paths.auditPath], {
			cwd, encoding: "utf8", env: { ...process.env, ...env },
		});
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

test("valid provenance verification has a deterministic fetch seam and reports success", async () => {
	const calls = [];
	const artifactBytes = Buffer.from("offline release artifact fixture\n");
	const result = await runFixture(() => {}, "valid", {
		fetchImpl: async (url, options) => {
			calls.push({ url: String(url), options });
			return { ok: true, arrayBuffer: async () => artifactBytes };
		},
	});
	assert.equal(result.status, 0);
	assert.equal(result.output.name, name);
	assert.equal(result.output.version, version);
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /registry\.npmjs\.org/);
	assert.equal(calls[0].options.redirect, "error");
	let tamperedCalls = 0;
	await assert.rejects(
		runFixture(() => {}, "valid", {
			fetchImpl: async () => {
				tamperedCalls += 1;
				return { ok: true, status: 200, arrayBuffer: async () => tamperedCalls === 1 ? Buffer.from("tampered\\n") : artifactBytes };
			},
			verifierOptions: { tarballFetchAttempts: 2, tarballFetchDelayMs: 0, sleepImpl: async () => {} },
		}),
		/registry tarball bytes fail integrity verification/,
	);
	assert.equal(tamperedCalls, 1);
});

test("transient registry tarball responses retry within a bound and permanent responses fail immediately", async () => {
	const artifactBytes = Buffer.from("offline release artifact fixture\n");
	const waits = [];
	let calls = 0;
	const result = await runFixture(() => {}, "valid", {
		fetchImpl: async () => {
			calls += 1;
			if (calls === 1) return { ok: true, status: 200, arrayBuffer: async () => { throw new TypeError("temporary body transport failure"); } };
			if (calls === 2) return { ok: false, status: 429 };
			if (calls === 3) return { ok: false, status: 599 };
			return { ok: true, status: 200, arrayBuffer: async () => artifactBytes };
		},
		verifierOptions: {
			tarballFetchAttempts: 4,
			tarballFetchDelayMs: 7,
			sleepImpl: async (delayMs) => { waits.push(delayMs); },
		},
	});
	assert.equal(result.status, 0);
	assert.equal(calls, 4);
	assert.deepEqual(waits, [7, 7, 7]);

	let forbiddenCalls = 0;
	await assert.rejects(
		runFixture(() => {}, "valid", {
			fetchImpl: async () => { forbiddenCalls += 1; return { ok: false, status: 403 }; },
			verifierOptions: { tarballFetchAttempts: 3, tarballFetchDelayMs: 0, sleepImpl: async () => {} },
		}),
		/HTTP 403/,
	);
	assert.equal(forbiddenCalls, 1);

	let exhaustedCalls = 0;
	await assert.rejects(
		runFixture(() => {}, "valid", {
			fetchImpl: async () => { exhaustedCalls += 1; return { ok: false, status: 404 }; },
			verifierOptions: { tarballFetchAttempts: 2, tarballFetchDelayMs: 0, sleepImpl: async () => {} },
		}),
		/HTTP 404/,
	);
	assert.equal(exhaustedCalls, 2);

	let timeoutCalls = 0;
	await assert.rejects(
		runFixture(() => {}, "valid", {
			fetchImpl: async (_url, { signal }) => {
				timeoutCalls += 1;
				return {
					ok: true,
					status: 200,
					arrayBuffer: async () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
				};
			},
			verifierOptions: { tarballFetchAttempts: 2, tarballFetchDelayMs: 0, tarballFetchTimeoutMs: 1, sleepImpl: async () => {} },
		}),
		/body read failed/,
	);
	assert.equal(timeoutCalls, 2);
});

test("producer envelopes are closed and single-field npm view drift is rejected", async () => {
	const result = await runFixture(() => {}, "single-field");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /post-publication keys/);
});

test("registry key rotation may return multiple signatures but never zero", async () => {
	const artifactBytes = Buffer.from("offline release artifact fixture\n");
	const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => artifactBytes });
	const rotated = await runFixture(() => {}, "valid", {
		fetchImpl,
		registrySignatures: [
			{ keyid: "fixture-key", sig: "fixture-signature-a" },
			{ keyid: "fixture-key", sig: "fixture-signature-b" },
		],
	});
	assert.equal(rotated.status, 0);
	await assert.rejects(
		runFixture(() => {}, "valid", { fetchImpl, registrySignatures: [] }),
		/must contain at least one registry signature/,
	);
});

test("unrelated signature records are not accepted as provenance", async () => {
	const result = await runFixture((e) => e.verified[0].attestationBundles.push(statement({ _type: "https://in-toto.io/Statement/v1", subject: subjects("x"), predicateType: "https://evil.example/predicate", predicate: {} }, "https://evil.example/predicate")));
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /duplicate or missing bundles/);
});

test("forged payloads and bad material refs fail exact checks", async () => {
	for (const mutate of [
		(e) => { e.verified[0].attestationBundles[1].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify({ _type: "https://in-toto.io/Statement/v1", subject: subjects("x"), predicateType: "https://slsa.dev/provenance/v1", predicate: {} })).toString("base64"); },
		(e) => { const p = JSON.parse(Buffer.from(e.verified[0].attestationBundles[1].bundle.dsseEnvelope.payload, "base64")); p.predicate.buildDefinition.resolvedDependencies[0].uri = "git+https://github.com/AgwaB/pi-workflow@refs/heads/evil"; e.verified[0].attestationBundles[1].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(p)).toString("base64"); },
	]) {
		const result = await runFixture(mutate);
		assert.notEqual(result.status, 0);
	}
});

test("wrong workflow identity is rejected even when the DSSE shape is otherwise valid", async () => {
	const result = await runFixture((e) => { const p = JSON.parse(Buffer.from(e.verified[0].attestationBundles[1].bundle.dsseEnvelope.payload, "base64")); p.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/other/repository"; e.verified[0].attestationBundles[1].bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(p)).toString("base64"); });
	assert.notEqual(result.status, 0);
});
