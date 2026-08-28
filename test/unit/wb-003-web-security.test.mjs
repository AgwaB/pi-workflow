import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { nonPublicIpReason } from "../../.tmp/unit/workflow-network-policy.js";
import { safeFetchWorkflowWebText } from "../../.tmp/unit/workflow-web-source-extension.js";
import { validateWorkflowWebUrl } from "../../.tmp/unit/workflow-web-source.js";

const strictSecurity = {
	allowPrivateHosts: false,
	cacheRawProviderPayloads: false,
};

function createInMemoryFetchFixture(onRequest) {
	let now = 0;
	let nextTimerId = 1;
	const timers = new Map();
	const requests = [];
	const scheduledDeadlines = [];
	const clearedDeadlines = [];

	const advance = (elapsedMs) => {
		now += elapsedMs;
		while (true) {
			const due = [...timers.entries()]
				.filter(([, timer]) => timer.dueAt <= now)
				.sort((left, right) =>
					left[1].dueAt - right[1].dueAt || left[0] - right[0],
				)[0];
			if (!due) return;
			const [timerId, timer] = due;
			timers.delete(timerId);
			timer.callback();
		}
	};

	const requestTransport = (transport) => (url, options, onResponse) => {
		const emitter = new EventEmitter();
		const record = {
			transport,
			url: url.href,
			options,
			requestTimeoutMs: undefined,
			destroyed: false,
		};
		requests.push(record);

		emitter.setTimeout = (timeoutMs, callback) => {
			record.requestTimeoutMs = timeoutMs;
			record.requestTimeoutCallback = callback;
		};
		emitter.destroy = (error) => {
			if (record.destroyed) return;
			record.destroyed = true;
			emitter.emit("error", error);
		};
		emitter.end = () => {
			onRequest({
				record,
				advance,
				respond({ statusCode, headers = {} }) {
					const response = new EventEmitter();
					response.statusCode = statusCode;
					response.headers = headers;
					response.setEncoding = () => undefined;
					response.resume = () => undefined;
					onResponse(response);
					return response;
				},
			});
		};
		return emitter;
	};

	return {
		advance,
		requests,
		scheduledDeadlines,
		clearedDeadlines,
		pendingDeadlineCount: () => timers.size,
		now: () => now,
		runtime: {
			now: () => now,
			httpRequest: requestTransport("http"),
			httpsRequest: requestTransport("https"),
			setDeadlineTimer(callback, delayMs) {
				const timerId = nextTimerId++;
				const dueAt = now + delayMs;
				timers.set(timerId, { callback, dueAt });
				scheduledDeadlines.push({ timerId, delayMs, dueAt });
				return timerId;
			},
			clearDeadlineTimer(timerId) {
				clearedDeadlines.push(timerId);
				timers.delete(timerId);
			},
		},
	};
}

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

test("WB-003 applies one wall-clock deadline to a slow-drip response", async () => {
	let response;
	const fixture = createInMemoryFetchFixture(({ respond }) => {
		response = respond({
			statusCode: 200,
			headers: { "content-type": "text/plain" },
		});
	});
	const pending = safeFetchWorkflowWebText(
		"https://slow.example/slow",
		strictSecurity,
		undefined,
		80,
		fixture.runtime,
	);

	assert.ok(response);
	for (let elapsed = 0; elapsed < 80; elapsed += 20) {
		response.emit("data", "x");
		fixture.advance(20);
	}
	const result = await pending;

	assert.equal(result.ok, false);
	assert.equal(result.reason, "fetch_deadline_exceeded");
	assert.equal(fixture.now(), 80);
	assert.deepEqual(fixture.scheduledDeadlines, [
		{ timerId: 1, delayMs: 80, dueAt: 80 },
	]);
	assert.deepEqual(fixture.clearedDeadlines, [1]);
	assert.equal(fixture.pendingDeadlineCount(), 0);
	assert.equal(fixture.requests.length, 1);
	assert.equal(fixture.requests[0].transport, "https");
	assert.equal(fixture.requests[0].requestTimeoutMs, 30_000);
	assert.equal(typeof fixture.requests[0].options.lookup, "function");
});

test("WB-003 returns the validated effective URL after a successful redirect", async () => {
	const fixture = createInMemoryFetchFixture(({ record, respond }) => {
		const requestUrl = new URL(record.url);
		if (requestUrl.pathname === "/requested") {
			const response = respond({
				statusCode: 302,
				headers: { location: "/effective" },
			});
			response.emit("end");
			return;
		}
		const response = respond({
			statusCode: 200,
			headers: { "content-type": "text/plain" },
		});
		response.emit("data", "redirected body");
		response.emit("end");
	});
	const result = await safeFetchWorkflowWebText(
		"https://redirect.example/requested",
		strictSecurity,
		undefined,
		100,
		fixture.runtime,
	);
	assert.deepEqual(result, {
		ok: true,
		url: "https://redirect.example/effective",
		text: "redirected body",
		title: undefined,
		aliases: ["https://redirect.example/requested"],
		extractionLossy: undefined,
	});
});

test("WB-003 does not reset the deadline across redirects", async () => {
	const fixture = createInMemoryFetchFixture(({ record, advance, respond }) => {
		const hop = Number(new URL(record.url).searchParams.get("hop") ?? 0);
		advance(25);
		if (record.destroyed) return;
		const response = respond({
			statusCode: 302,
			headers: { location: `/?hop=${hop + 1}` },
		});
		response.emit("end");
	});
	const result = await safeFetchWorkflowWebText(
		"http://redirect.example/?hop=0",
		strictSecurity,
		undefined,
		70,
		fixture.runtime,
	);

	assert.equal(result.ok, false);
	assert.equal(result.reason, "fetch_deadline_exceeded");
	assert.equal(fixture.now(), 75);
	assert.deepEqual(
		fixture.scheduledDeadlines.map(({ delayMs, dueAt }) => ({ delayMs, dueAt })),
		[
			{ delayMs: 70, dueAt: 70 },
			{ delayMs: 45, dueAt: 70 },
			{ delayMs: 20, dueAt: 70 },
		],
	);
	assert.deepEqual(fixture.clearedDeadlines, [1, 2, 3]);
	assert.equal(fixture.pendingDeadlineCount(), 0);
	assert.deepEqual(
		fixture.requests.map(({ transport }) => transport),
		["http", "http", "http"],
	);
	assert.deepEqual(
		fixture.requests.map(({ requestTimeoutMs }) => requestTimeoutMs),
		[30_000, 30_000, 30_000],
	);
	assert.ok(fixture.requests.every(({ options }) => typeof options.lookup === "function"));
});
