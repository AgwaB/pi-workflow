import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { nonPublicIpReason } from "../../.tmp/unit/workflow-network-policy.js";
import { safeFetchWorkflowWebText } from "../../.tmp/unit/workflow-web-source-extension.js";
import { validateWorkflowWebUrl } from "../../.tmp/unit/workflow-web-source.js";

const strictSecurity = {
	allowPrivateHosts: false,
	cacheRawProviderPayloads: false,
};
const localFixtureSecurity = {
	allowPrivateHosts: true,
	cacheRawProviderPayloads: false,
};

test("WB-003 rejects the complete IPv6 link-local range and other non-global addresses", () => {
	for (const address of [
		"fe80::1",
		"fe90::1",
		"fea0::1",
		"febf::1",
		"fc00::1",
		"ff02::1",
		"::",
		"::1",
		"2001:db8::1",
		"64:ff9b::a00:1",
		"fe80::1%en0",
		"::ffff:10.0.0.1",
		"::ffff:a00:1",
	]) {
		assert.equal(nonPublicIpReason(address), "private_host_blocked", address);
	}

	for (const address of [
		"8.8.8.8",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
		"::ffff:808:808",
	]) {
		assert.equal(nonPublicIpReason(address), undefined, address);
	}

	assert.deepEqual(validateWorkflowWebUrl("http://[fe90::1]/", strictSecurity), {
		ok: false,
		reason: "private_host_blocked",
	});
	assert.equal(
		validateWorkflowWebUrl(
			"https://[2606:4700:4700::1111]/",
			strictSecurity,
		).ok,
		true,
	);
});

test("WB-003 applies one wall-clock deadline to a slow-drip response", async (t) => {
	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		const interval = setInterval(() => response.write("x"), 15);
		response.on("close", () => clearInterval(interval));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, "object");
	const startedAt = Date.now();
	const result = await safeFetchWorkflowWebText(
		`http://127.0.0.1:${address.port}/slow`,
		localFixtureSecurity,
		undefined,
		80,
	);
	const elapsedMs = Date.now() - startedAt;
	assert.equal(result.ok, false);
	assert.equal(result.reason, "fetch_deadline_exceeded");
	assert.ok(elapsedMs >= 50, `deadline fired too early: ${elapsedMs}ms`);
	assert.ok(elapsedMs < 500, `deadline was not absolute: ${elapsedMs}ms`);
});

test("WB-003 does not reset the deadline across redirects", async (t) => {
	const server = createServer((request, response) => {
		const hop = Number(new URL(request.url, "http://fixture").searchParams.get("hop") ?? 0);
		setTimeout(() => {
			if (hop < 5) {
				response.writeHead(302, { location: `/?hop=${hop + 1}` });
				response.end();
				return;
			}
			response.writeHead(200, { "content-type": "text/plain" });
			response.end("done");
		}, 25);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise((resolve) => server.close(resolve)));
	const address = server.address();
	assert.equal(typeof address, "object");
	const result = await safeFetchWorkflowWebText(
		`http://127.0.0.1:${address.port}/?hop=0`,
		localFixtureSecurity,
		undefined,
		70,
	);
	assert.equal(result.ok, false);
	assert.equal(result.reason, "fetch_deadline_exceeded");
});
