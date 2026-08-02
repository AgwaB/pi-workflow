import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const unitDir = dirname(fileURLToPath(import.meta.url));
const domainFiles = [
	"unit-artifact-web.test.mjs",
	"unit-authoring-interface.test.mjs",
	"unit-core-runtime.test.mjs",
	"unit-dynamic-runtime.test.mjs",
	"unit-engine-store.test.mjs",
];

test("unit domain split preserves the exact 527-test inventory", () => {
	assert.equal(existsSync(join(unitDir, "unit.test.mjs")), false);
	let inventory;
	try {
		inventory = JSON.parse(
			readFileSync(join(unitDir, "unit-test-inventory.json"), "utf8"),
		);
	} catch (error) {
		assert.fail(`invalid unit-test inventory JSON: ${error}`);
	}
	assert.equal(inventory.schema, "pi-workflow-unit-test-inventory-v1");
	assert.equal(inventory.count, 527);

	const actual = [];
	const occurrences = new Map();
	for (const file of domainFiles) {
		const domain = file.slice("unit-".length, -".test.mjs".length);
		const source = readFileSync(join(unitDir, file), "utf8");
		const sourceFile = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.JS,
		);
		let fileCount = 0;
		for (const statement of sourceFile.statements) {
			const expression = statement.expression;
			if (
				!ts.isExpressionStatement(statement) ||
				!ts.isCallExpression(expression) ||
				!ts.isIdentifier(expression.expression) ||
				expression.expression.text !== "test"
			) {
				continue;
			}
			const nameArg = expression.arguments[0];
			assert.ok(
				ts.isStringLiteralLike(nameArg),
				`${file} has a dynamic test name`,
			);
			const name = nameArg.text;
			const occurrence = (occurrences.get(name) ?? 0) + 1;
			occurrences.set(name, occurrence);
			actual.push({
				name,
				occurrence,
				sha256: createHash("sha256")
					.update(source.slice(statement.getStart(), statement.end))
					.digest("hex"),
				domain,
			});
			fileCount += 1;
		}
		assert.ok(
			fileCount > 0 && fileCount <= 150,
			`${file} has ${fileCount} tests`,
		);
		assert.ok(
			source.split("\n").length <= 12_000,
			`${file} is still monolithic`,
		);
	}

	const sortKey = (item) =>
		`${item.name}\u0000${String(item.occurrence).padStart(4, "0")}\u0000${item.domain}`;
	assert.deepEqual(
		actual.toSorted((left, right) =>
			sortKey(left).localeCompare(sortKey(right)),
		),
		inventory.tests.toSorted((left, right) =>
			sortKey(left).localeCompare(sortKey(right)),
		),
	);
	const support = readFileSync(join(unitDir, "unit-test-support.mjs"), "utf8");
	const supportFile = ts.createSourceFile(
		"unit-test-support.mjs",
		support,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	assert.equal(
		supportFile.statements.some((statement) => {
			const expression = statement.expression;
			return (
				ts.isExpressionStatement(statement) &&
				ts.isCallExpression(expression) &&
				ts.isIdentifier(expression.expression) &&
				expression.expression.text === "test"
			);
		}),
		false,
	);
});
