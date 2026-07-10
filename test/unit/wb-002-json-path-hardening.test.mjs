import assert from "node:assert/strict";
import test from "node:test";

import {
	projectArtifactGraphControl,
	setProjectedJsonPath,
} from "../../.tmp/unit/artifact-graph-runtime.js";
import { buildSourceContextPacket } from "../../.tmp/unit/workflow-artifacts.js";
import {
	isSimpleJsonPath,
	readSimpleJsonPath,
} from "../../.tmp/unit/workflow-runtime.js";

const POLLUTION_KEY = "wb002Polluted";

function jsonRoundTrip(value) {
	return JSON.parse(JSON.stringify(value));
}

test("WB-002 simple JSON paths consume full input and read only own properties", () => {
	const inherited = { secret: "prototype-value" };
	const value = Object.create(inherited);
	value.safe = { answer: 42 };
	value.constructor = { answer: "blocked" };
	value.items = [{ id: "own-0" }, { id: "own-1" }];

	const sparse = [, { id: "own-1" }];
	Object.setPrototypeOf(sparse, { 0: { id: "inherited-0" } });
	value.sparse = sparse;

	assert.equal(readSimpleJsonPath(value, "$.safe.answer"), 42);
	assert.equal(readSimpleJsonPath(value, "$.secret"), undefined);
	assert.equal(readSimpleJsonPath(value, "$.constructor.answer"), undefined);
	assert.equal(readSimpleJsonPath(value, "$.sparse[0].id"), undefined);
	assert.equal(readSimpleJsonPath(value, "$.sparse[1].id"), "own-1");
	assert.deepEqual(readSimpleJsonPath(value, "$.sparse[*].id"), ["own-1"]);

	for (const path of [
		"$.safe.answer trailing",
		"$.safe.answer[0]junk",
		"$.safe..answer",
		"$.safe['answer']",
		"$.__proto__.polluted",
		"$.prototype.polluted",
		"$.constructor.prototype.polluted",
	]) {
		assert.equal(isSimpleJsonPath(path), false, path);
		assert.equal(readSimpleJsonPath(value, path), undefined, path);
	}
});

test("WB-002 projections use null-prototype containers without polluting Object.prototype", () => {
	try {
		delete Object.prototype[POLLUTION_KEY];

		const target = {};
		setProjectedJsonPath(target, `$.__proto__.${POLLUTION_KEY}`, true);
		setProjectedJsonPath(target, `$.constructor.prototype.${POLLUTION_KEY}`, true);
		setProjectedJsonPath(target, "$.valid.path", 1);

		assert.equal(Object.prototype[POLLUTION_KEY], undefined);
		assert.deepEqual(jsonRoundTrip(target), { valid: { path: 1 } });
		assert.equal(Object.getPrototypeOf(target.valid), null);

		const projected = projectArtifactGraphControl(
			{
				safe: { nested: 7 },
				items: [{ id: "first" }],
			},
			{
				include: [
					"$.safe.nested",
					"$.items[0].id",
					`$.__proto__.${POLLUTION_KEY}`,
					`$.constructor.prototype.${POLLUTION_KEY}`,
				],
			},
		);

		assert.equal(Object.prototype[POLLUTION_KEY], undefined);
		assert.deepEqual(jsonRoundTrip(projected.value), {
			safe: { nested: 7 },
			"items[0]": { id: "first" },
		});
		assert.deepEqual(projected.missingPaths, [
			`$.__proto__.${POLLUTION_KEY}`,
			`$.constructor.prototype.${POLLUTION_KEY}`,
		]);
		assert.equal(Object.getPrototypeOf(projected.value), null);
		assert.equal(Object.getPrototypeOf(projected.value.safe), null);
		assert.equal(Object.getPrototypeOf(projected.value["items[0]"]), null);

		const maliciousOutput = JSON.parse(
			`{"safe":{"nested":7},"a":{"__proto__":{"${POLLUTION_KEY}":"yes"}},"__proto__":{"${POLLUTION_KEY}":"root"},"prototype":{"${POLLUTION_KEY}":"proto"},"constructor":{"prototype":{"${POLLUTION_KEY}":"ctor"}}}`,
		);
		assert.equal(Object.hasOwn(maliciousOutput.a, "__proto__"), true);
		const packet = buildSourceContextPacket(
			{ tasks: [{ taskId: "source-task", stageId: "source" }] },
			{
				structuredOutputsByTaskId: { "source-task": maliciousOutput },
				structuredOutputPathsByStage: {
					source: [
						"$.safe.nested",
						`$.a.__proto__.${POLLUTION_KEY}`,
						`$.__proto__.${POLLUTION_KEY}`,
						`$.prototype.${POLLUTION_KEY}`,
						`$.constructor.prototype.${POLLUTION_KEY}`,
						"$.safe.nested trailing",
					],
				},
			},
		);

		assert.equal(Object.prototype[POLLUTION_KEY], undefined);
		assert.deepEqual(packet.tasks[0].structuredOutput, {
			safe: { nested: 7 },
		});
		assert.equal(
			Object.getPrototypeOf(packet.tasks[0].structuredOutput),
			Object.prototype,
		);
		assert.equal(
			Object.getPrototypeOf(packet.tasks[0].structuredOutput.safe),
			Object.prototype,
		);
		assert.deepEqual(packet.tasks[0].projectionWarnings, [
			{ path: `$.a.__proto__.${POLLUTION_KEY}`, reason: "missing" },
			{ path: `$.__proto__.${POLLUTION_KEY}`, reason: "missing" },
			{ path: `$.prototype.${POLLUTION_KEY}`, reason: "missing" },
			{
				path: `$.constructor.prototype.${POLLUTION_KEY}`,
				reason: "missing",
			},
			{ path: "$.safe.nested trailing", reason: "missing" },
		]);
	} finally {
		delete Object.prototype[POLLUTION_KEY];
	}
});
