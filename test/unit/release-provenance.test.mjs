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
function dist(integrity) {
	return {
		integrity, shasum: "fixture-sha", tarball: `${registry}/@agwab/pi-workflow/-/pi-workflow-${version}.tgz`,
		fileCount: 1, unpackedSize: 1,
		attestations: { url: `${registry}/-/npm/v1/attestations/@agwab%2fpi-workflow@${version}`, provenance: { predicateType: "https://slsa.dev/provenance/v1" } },
		signatures: [{ keyid: "fixture-key", sig: "fixture-signature" }],
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

async function runFixture(mutate, after = "valid", { fetchImpl } = {}) {
	const cwd = await mkdtemp(join(tmpdir(), "pi-release-provenance-"));
	try {
		const bytes = Buffer.from("offline release artifact fixture\n");
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		await writeFile(join(cwd, "package.tgz"), bytes);
		await writeFile(join(cwd, "before.json"), JSON.stringify(envelope(null)));
		await writeFile(join(cwd, "after.json"), JSON.stringify(after === "single-field" ? { dist: dist(integrity) } : envelope(dist(integrity))));
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
			const output = await verifyNpmPublication({ ...paths, env, fetchImpl });
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
	await assert.rejects(
		runFixture(() => {}, "valid", { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from("tampered\\n") }) }),
		/registry tarball bytes fail integrity verification/,
	);
});

test("producer envelopes are closed and single-field npm view drift is rejected", async () => {
	const result = await runFixture(() => {}, "single-field");
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /post-publication keys/);
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
