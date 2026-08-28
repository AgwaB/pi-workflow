#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export async function verifyNpmPublication({
	packagePath,
	beforePath,
	afterPath,
	tagsPath,
	auditPath,
	env = process.env,
	fetchImpl = globalThis.fetch,
} = {}) {
	if (!packagePath || !beforePath || !afterPath || !tagsPath || !auditPath) {
		throw new Error(
			"usage: verify-npm-publication.mjs PACKAGE_TGZ BEFORE_JSON AFTER_JSON DIST_TAGS_JSON NPM_AUDIT_SIGNATURES_JSON",
		);
	}

	const expectedName = env.NPM_PACKAGE;
	const expectedVersion = env.TARGET_VERSION;
	const expectedRepository = env.EXPECTED_REPOSITORY;
	const expectedCommit = env.RELEASE_COMMIT;
	const expectedWorkflowRef = env.EXPECTED_WORKFLOW_REF;
	const expectedWorkflowPath = env.EXPECTED_WORKFLOW_PATH;
	const registry = "https://registry.npmjs.org";
	const registryWithSlash = `${registry}/`;
	if (
		expectedName !== "@agwab/pi-workflow" ||
		!expectedVersion ||
		expectedRepository !== "AgwaB/pi-workflow" ||
		!expectedCommit ||
		expectedWorkflowRef !== "refs/heads/main" ||
		expectedWorkflowPath !== ".github/workflows/publish.yml"
	) {
		throw new Error("publication verification identity is not the pinned release identity");
	}

	const packageBytes = readFileSync(packagePath);
	const packageIntegrity = `sha512-${createHash("sha512").update(packageBytes).digest("base64")}`;
	const subjectDigestHex = createHash("sha512").update(packageBytes).digest("hex");
	const subjectPurl = `pkg:npm/%40agwab/pi-workflow@${expectedVersion}`;
	const before = readJson(beforePath);
	const publication = readJson(afterPath);
	const tags = readJson(tagsPath);
	const audit = readJson(auditPath);

	assertPublicationEnvelope(before, "pre-publication", true, expectedName, expectedVersion, registry);
	assertPublicationEnvelope(publication, "post-publication", false, expectedName, expectedVersion, registry);
	assert.equal(tags.latest, expectedVersion, "the approved latest dist-tag does not select this version");
	assert.deepEqual(Object.keys(tags), ["latest"], "dist-tags response contains unrelated tags");
	assert.equal(publication.dist.integrity, packageIntegrity, "published tarball integrity differs from the promoted artifact");
	assert.equal(publication.dist.tarball, `${registry}/@agwab/pi-workflow/-/pi-workflow-${expectedVersion}.tgz`, "published tarball URL is not canonical");

	// The npm CLI is the cryptographic gate. This checker consumes only its
	// verified result; it never treats a registry response or a DSSE signature as
	// proof by itself and never implements Sigstore verification.
	const verified = assertExactAuditResult(audit, subjectPurl, expectedName, expectedVersion, registryWithSlash, registry);
	const bundles = assertVerifiedRecord(verified, subjectPurl, packageIntegrity);
	const provenanceBundle = assertBundlesAndSelectProvenance(bundles, subjectPurl, subjectDigestHex);
	assertExactProvenancePayload(
		provenanceBundle,
		subjectPurl,
		subjectDigestHex,
		expectedRepository,
		expectedCommit,
		expectedWorkflowRef,
		expectedWorkflowPath,
	);

	const tarballUrl = new URL(publication.dist.tarball);
	assert.equal(tarballUrl.protocol, "https:", "published tarball is not HTTPS");
	assert.equal(tarballUrl.origin, registry, "published tarball is not from the approved registry");
	if (typeof fetchImpl !== "function") throw new Error("publication tarball fetch implementation is unavailable");
	const response = await fetchImpl(tarballUrl, { redirect: "error" });
	if (!response.ok) throw new Error(`published tarball fetch failed: HTTP ${response.status}`);
	const remoteBytes = Buffer.from(await response.arrayBuffer());
	assert.equal(
		`sha512-${createHash("sha512").update(remoteBytes).digest("base64")}`,
		packageIntegrity,
		"registry tarball bytes fail integrity verification",
	);
	assert.deepEqual(remoteBytes, packageBytes, "registry tarball bytes differ from the promoted artifact");

	return {
		name: expectedName,
		version: expectedVersion,
		registry,
		distTag: "latest",
		integrity: packageIntegrity,
		provenance: "verified-by-npm-audit-signatures-and-source-bound",
		commit: expectedCommit,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [packagePath, beforePath, afterPath, tagsPath, auditPath] = process.argv.slice(2);
	verifyNpmPublication({ packagePath, beforePath, afterPath, tagsPath, auditPath })
		.then((result) => console.log(JSON.stringify(result, null, 2)))
		.catch((error) => {
			console.error(error);
			process.exitCode = 1;
		});
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function assertPublicationEnvelope(value, label, allowUnpublished, expectedName, expectedVersion, registry) {
	assertExactKeys(value, ["name", "version", "dist"], label);
	assert.equal(value.name, expectedName, `${label} returned the wrong package`);
	assert.equal(value.version, expectedVersion, `${label} returned the wrong version`);
	if (allowUnpublished && value.dist === null) return;
	assert.ok(value.dist && typeof value.dist === "object" && !Array.isArray(value.dist), `${label} dist is missing`);
	assertExactKeys(
		value.dist,
		["integrity", "shasum", "tarball", "fileCount", "unpackedSize", "attestations", "signatures"],
		`${label}.dist`,
	);
	assert.equal(typeof value.dist.integrity, "string", `${label} integrity is missing`);
	assert.equal(typeof value.dist.shasum, "string", `${label} shasum is missing`);
	assert.equal(typeof value.dist.tarball, "string", `${label} tarball is missing`);
	assert.equal(typeof value.dist.fileCount, "number", `${label} fileCount is missing`);
	assert.equal(typeof value.dist.unpackedSize, "number", `${label} unpackedSize is missing`);
	assertExactKeys(value.dist.attestations, ["url", "provenance"], `${label}.dist.attestations`);
	assert.equal(value.dist.attestations.url, `${registry}/-/npm/v1/attestations/@agwab%2fpi-workflow@${expectedVersion}`);
	assertExactObject(value.dist.attestations.provenance, { predicateType: "https://slsa.dev/provenance/v1" }, `${label}.dist.attestations.provenance`);
	assert.ok(Array.isArray(value.dist.signatures) && value.dist.signatures.length === 1, `${label} must contain one registry signature`);
	for (const signature of value.dist.signatures) {
		assertExactKeys(signature, ["keyid", "sig"], `${label}.dist.signatures[]`);
		assert.equal(typeof signature.keyid, "string");
		assert.equal(typeof signature.sig, "string");
	}
}

function assertExactAuditResult(value, subjectPurl, expectedName, expectedVersion, registryWithSlash, registry) {
	assertExactKeys(value, ["invalid", "missing", "verified"], "npm audit signatures result");
	assert.deepEqual(value.invalid, [], "npm audit signatures reported invalid records");
	assert.deepEqual(value.missing, [], "npm audit signatures reported missing records");
	assert.ok(Array.isArray(value.verified), "npm audit signatures verified result is not an array");
	assert.equal(value.verified.length, 1, "npm audit signatures returned duplicate or unrelated records");
	const matches = value.verified.filter(
		(record) => record && record.name === expectedName && record.version === expectedVersion,
	);
	assert.equal(matches.length, 1, "npm audit signatures did not return exactly one target record");
	assert.equal(value.verified.filter((record) => record?.name === expectedName).length, 1, "duplicate target signature records were returned");
	assert.equal(matches[0].registry, registryWithSlash, "npm audit signatures used an unapproved registry");
	assert.equal(matches[0].location, `node_modules/${expectedName}`, "npm audit signatures target location drifted");
	assert.equal(matches[0].attestations?.url, `${registry}/-/npm/v1/attestations/@agwab%2fpi-workflow@${expectedVersion}`);
	return matches[0];
}

function assertVerifiedRecord(record, subjectPurl, packageIntegrity) {
	assertExactKeys(record, ["name", "version", "location", "registry", "attestations", "attestationBundles"], "verified npm record");
	assertExactKeys(record.attestations, ["url", "provenance"], "verified npm record attestations");
	assertExactObject(record.attestations.provenance, { predicateType: "https://slsa.dev/provenance/v1" }, "verified npm provenance reference");
	assert.ok(Array.isArray(record.attestationBundles), "verified npm record has no attestation bundles");
	assert.equal(record.attestationBundles.length, 2, "verified npm record contains duplicate or missing bundles");
	return record.attestationBundles;
}

function assertBundlesAndSelectProvenance(bundles, subjectPurl, subjectDigestHex) {
	const byPredicate = new Map();
	for (const entry of bundles) {
		assertExactKeys(entry, ["predicateType", "bundle", "signedAccessSignatureUrl"], "attestation bundle record");
		assert.equal(entry.signedAccessSignatureUrl, "", "unexpected signed access signature URL");
		assert.equal(typeof entry.predicateType, "string");
		assert.ok(!byPredicate.has(entry.predicateType), "duplicate attestation predicate");
		byPredicate.set(entry.predicateType, entry);
		assertExactKeys(entry.bundle, ["mediaType", "verificationMaterial", "dsseEnvelope"], "attestation bundle");
		assert.match(entry.bundle.mediaType, /^application\/vnd\.dev\.sigstore\.bundle(?:\+json;version=0\.2|\.v0\.3\+json)$/);
		assert.ok(entry.bundle.verificationMaterial && typeof entry.bundle.verificationMaterial === "object");
		assert.ok(Array.isArray(entry.bundle.verificationMaterial.tlogEntries) && entry.bundle.verificationMaterial.tlogEntries.length > 0, "bundle has no transparency-log verification material");
		assertExactKeys(entry.bundle.dsseEnvelope, ["payload", "payloadType", "signatures"], "DSSE envelope");
		assert.equal(entry.bundle.dsseEnvelope.payloadType, "application/vnd.in-toto+json");
		assert.ok(Array.isArray(entry.bundle.dsseEnvelope.signatures) && entry.bundle.dsseEnvelope.signatures.length === 1, "bundle must contain one DSSE signature");
		assert.equal(typeof entry.bundle.dsseEnvelope.payload, "string");
		for (const signature of entry.bundle.dsseEnvelope.signatures) {
			assertExactKeys(signature, ["sig", "keyid"], "DSSE signature");
			assert.equal(typeof signature.sig, "string");
			assert.equal(typeof signature.keyid, "string");
		}
		const payload = decodePayload(entry.bundle.dsseEnvelope.payload);
		assert.equal(payload.predicateType, entry.predicateType, "bundle predicate and payload predicate disagree");
		assert.equal(payload._type, entry.predicateType === "https://slsa.dev/provenance/v1" ? "https://in-toto.io/Statement/v1" : "https://in-toto.io/Statement/v0.1");
		assertSubject(payload, subjectPurl, subjectDigestHex);
	}
	assert.deepEqual([...byPredicate.keys()].sort(), [
		"https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
		"https://slsa.dev/provenance/v1",
	].sort(), "attestation bundle set contains an unrelated or missing record");
	return byPredicate.get("https://slsa.dev/provenance/v1");
}

function assertExactProvenancePayload(entry, subjectPurl, subjectDigestHex, repository, commit, workflowRef, workflowPath) {
	const payload = decodePayload(entry.bundle.dsseEnvelope.payload);
	assertExactKeys(payload, ["_type", "subject", "predicateType", "predicate"], "in-toto statement");
	assertExactKeys(payload.predicate, ["buildDefinition", "runDetails"], "SLSA predicate");
	const build = payload.predicate.buildDefinition;
	assertExactKeys(build, ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"], "SLSA build definition");
	assert.equal(build.buildType, "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1");
	assertExactKeys(build.externalParameters, ["workflow"], "SLSA external parameters");
	assertExactObject(build.externalParameters.workflow, { ref: workflowRef, repository: `https://github.com/${repository}`, path: workflowPath }, "SLSA workflow identity");
	assertExactKeys(build.internalParameters, ["github"], "SLSA internal parameters");
	assertExactKeys(build.internalParameters.github, ["event_name", "repository_id", "repository_owner_id"], "SLSA GitHub parameters");
	assert.equal(build.internalParameters.github.event_name, "workflow_dispatch");
	assertExactKeys(build.resolvedDependencies[0], ["uri", "digest"], "SLSA material");
	assert.equal(build.resolvedDependencies.length, 1, "SLSA contains unrelated materials");
	assert.equal(build.resolvedDependencies[0].uri, `git+https://github.com/${repository}@${workflowRef}`, "SLSA material URI is not canonical");
	assertExactObject(build.resolvedDependencies[0].digest, { gitCommit: commit }, "SLSA material digest");
	assertExactKeys(payload.predicate.runDetails, ["builder", "metadata"], "SLSA run details");
	assertExactObject(payload.predicate.runDetails.builder, { id: "https://github.com/actions/runner/github-hosted" }, "SLSA builder");
	assertExactKeys(payload.predicate.runDetails.metadata, ["invocationId"], "SLSA run metadata");
	assert.match(payload.predicate.runDetails.metadata.invocationId, new RegExp(`^https://github\\.com/${escapeRegExp(repository)}/actions/runs/[0-9]+/attempts/[0-9]+$`));
}

function assertSubject(payload, subjectPurl, subjectDigestHex) {
	assert.ok(Array.isArray(payload.subject) && payload.subject.length === 1, "attestation has duplicate or unrelated subjects");
	assertExactKeys(payload.subject[0], ["name", "digest"], "attestation subject");
	assert.equal(payload.subject[0].name, subjectPurl, "attestation subject PURL differs from the package");
	assertExactObject(payload.subject[0].digest, { sha512: subjectDigestHex }, "attestation subject digest");
}

function decodePayload(encoded) {
	assert.equal(typeof encoded, "string");
	const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
	assert.ok(payload && typeof payload === "object" && !Array.isArray(payload), "DSSE payload is not an object");
	return payload;
}

function assertExactKeys(value, expected, label) {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
	assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} keys`);
}

function assertExactObject(value, expected, label) {
	assertExactKeys(value, Object.keys(expected), label);
	assert.deepEqual(value, expected, label);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
