import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";
import { makeProject, notifyUnfinishedRuns, writeUnfinishedNoticeIndex, writeUnfinishedNoticeIndexRun } from "./unit-test-support.mjs";
test("notifyUnfinishedRuns points a stopped Goal to goal recover and a failed Goal to goal status", async () => {
	const cwd = makeProject();
	try {
		const nowMs = Date.parse("2026-06-12T12:00:00.000Z");
		const goalRun = (runId, status) => writeUnfinishedNoticeIndexRun({
			runId, name: `goal-${status}`, status,
			goalParticipation: { schemaVersion: 1, resumeRequired: true, goalPaths: ["src/a.mjs"] },
			tasks: [{ taskId: "task-1", specId: "goal.main", displayName: "goal.main", kind: "goal", agent: "goal",
				status, statusDetail: status, backendTaskId: "", files: {} }],
		});
		writeUnfinishedNoticeIndex(cwd, [
			goalRun("workflow_goalstopped", "interrupted"),
			goalRun("workflow_goalfailed", "failed"),
			writeUnfinishedNoticeIndexRun({ runId: "workflow_plain", name: "plain", status: "interrupted" }),
		]);
		const notices = [];
		await notifyUnfinishedRuns(cwd, (message, type) => notices.push({ message, type }), nowMs);
		assert.equal(notices.length, 1);
		const text = notices[0].message;
		assert.match(text, /workflow_goalstopped: interrupted.* — \/workflow goal recover workflow_goalstopped$/m);
		assert.match(text, /workflow_goalfailed: failed.* — \/workflow goal status workflow_goalfailed$/m);
		assert.match(text, /workflow_plain: \w+.* — \/workflow resume workflow_plain$/m, "other workflows keep /workflow resume");
		assert.doesNotMatch(text, /\/workflow resume workflow_goal/, "a Goal is never sent to /workflow resume");
	} finally {
		rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 10 });
	}
});
