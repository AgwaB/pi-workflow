import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	LEGACY_TERM_EXCLUSIONS,
	LEGACY_TERM_SCAN_PATHS,
	scanForbiddenTerms,
} from "../e2e/forbidden-term-scanner.mjs";

test("forbidden-term scanner distinguishes clean and forbidden-match results", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-forbidden-scan-"));
	try {
		mkdirSync(join(root, "public"));
		writeFileSync(join(root, "public", "clean.txt"), "nothing prohibited\n");
		assert.deepEqual(
			scanForbiddenTerms({ root, paths: ["public"], patterns: ["needle"] }),
			{ status: "clean", matches: [] },
		);
		writeFileSync(join(root, "public", "match.txt"), "first\nneedle here\n");
		const result = scanForbiddenTerms({
			root,
			paths: ["public"],
			patterns: ["needle"],
		});
		assert.equal(result.status, "forbidden-match");
		assert.deepEqual(result.matches, [
			{ path: "public/match.txt", line: 2, column: 1, pattern: "needle" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("forbidden-term scanner reports setup errors and retains historical handoff exclusions", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-workflow-forbidden-scan-"));
	try {
		const missing = scanForbiddenTerms({
			root,
			paths: ["does-not-exist"],
			patterns: ["needle"],
		});
		assert.equal(missing.status, "read/setup-error");
		assert.ok(missing.errors.length > 0);

		mkdirSync(join(root, ".tmp", "handoff"), { recursive: true });
		writeFileSync(join(root, ".tmp", "handoff", "record.md"), "needle\n");
		assert.equal(
			scanForbiddenTerms({
				root,
				paths: [".tmp"],
				patterns: ["needle"],
			}).status,
			"clean",
		);
		assert.ok(LEGACY_TERM_SCAN_PATHS.includes("test"));
		assert.ok(LEGACY_TERM_EXCLUSIONS.includes(".tmp/**"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
