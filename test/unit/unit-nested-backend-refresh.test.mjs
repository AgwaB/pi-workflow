import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as h from "./unit-test-support.mjs";
import { withMaterializedRawHost } from "./raw-host-fixture.mjs";
import { setSubagentApiForTests as setRawApi } from "../../.tmp/unit/subagent-backend.js";
const setApi = withMaterializedRawHost(setRawApi);

test("refreshes a suspended nested child under its lease and advances sequential stages", async () => {
  const cwd = h.makeProject();
  const launched = [];
  const statusPolls = [];
  try {
    h.writeAgent(cwd, "unit-scout", "read");
    setApi({
      async runSubagent(options) {
        const n = launched.length + 1;
        const runId = `backend-child-${n}`;
        const attemptId = `attempt-${n}`;
        const runsDir = String(options.runsDir ?? ".pi/agent/runs");
        const runDir = runsDir.startsWith("/") ? join(runsDir, runId) : join(cwd, runsDir, runId);
        const artifactDir = join(runDir, "attempts", attemptId);
        mkdirSync(artifactDir, { recursive: true });
        writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId, attemptId, status: "running" }));
        writeFileSync(join(artifactDir, "output.log"), `<control>\n{"schema":"stage-control-v1","digest":"stage-${n}"}\n</control>\n<analysis>done</analysis>\n<refs>\n[]\n</refs>`);
        writeFileSync(join(artifactDir, "stderr.log"), "");
        writeFileSync(join(artifactDir, "result.json"), JSON.stringify({ status: "completed", exitCode: 0 }));
        launched.push({ runId, attemptId, artifactDir, stage: n, polls: 0 });
        return { runId, attemptId, status: "running" };
      },
      async reconcileSubagentRun() { return {}; },
      async getSubagentStatus({ runId, attemptId }) {
        statusPolls.push(runId);
        const item = launched.find((x) => x.runId === runId);
        assert.ok(item);
        item.polls += 1;
        const status = item.stage === 1 || item.polls >= 2 ? "completed" : "running";
        return {
          runId, attemptId, backend: "headless", status,
          failureKind: null, startedAt: new Date(Date.now() - 10).toISOString(),
          completedAt: new Date().toISOString(), metadata: { contextLengthExceeded: false },
          logs: [
            { type: "output", path: "output.log", artifactCwd: item.artifactDir },
            { type: "stderr", path: "stderr.log", artifactCwd: item.artifactDir },
            { type: "result", path: "result.json", artifactCwd: item.artifactDir },
          ],
          attempts: [{ attemptId, status: "completed" }],
        };
      },
      async interruptSubagent() { return {}; },
    });
    const childSpec = {
      schemaVersion: 1, name: "child", defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
      artifactGraph: { stages: [
        { id: "one", type: "single", prompt: "one" },
        { id: "two", type: "single", after: ["one"], prompt: "two" },
      ] },
    };
    const rootSpec = {
      schemaVersion: 1, name: "root", defaults: { agent: "unit-scout", readOnly: true, tools: ["read"] },
      artifactGraph: { stages: [{ id: "adaptive", type: "dynamic", dynamic: { uses: "./controller.mjs", workflows: { child: { uses: "./child/spec.json" } } } }] },
    };
    mkdirSync(join(cwd, "child"), { recursive: true });
    writeFileSync(join(cwd, "child", "spec.json"), JSON.stringify(childSpec));
    writeFileSync(join(cwd, "controller.mjs"), "export default async ctx => ({control:{child:(await ctx.workflow('child','nested')).control}});");
    const compiled = await h.compileWorkflow(rootSpec, { cwd, task: "root", specPath: join(cwd, "spec.json") });
    writeFileSync(join(cwd, "spec.json"), JSON.stringify(rootSpec));
    const { run } = await h.createWorkflowRunRecord(cwd, compiled, join(cwd, "spec.json"));
    await h.writeStaticRunArtifacts(cwd, run, compiled, rootSpec);
    await h.writeRunRecord(cwd, run);

    await h.scheduleRun(cwd, run.runId);
    let current = await h.readRunRecord(cwd, run.runId);
    assert.equal(h.taskBySpec(current, "adaptive.controller").statusDetail, "suspended_waiting_children", h.taskBySpec(current, "adaptive.controller").lastMessage);
    assert.equal(launched.length, 1, "first child stage starts once");
    // The child remains recorded RUNNING; only backend refresh may make it terminal.
    const childRunId = (await h.readDynamicEvents(cwd, run.runId)).find((e) => e.type === "workflow.started")?.payload.runId;
    assert.ok(childRunId);
    assert.equal((await h.readRunRecord(cwd, childRunId)).status, "running");
    // A concurrent child supervisor owns the child lease. The parent poll must
    // defer without invoking the backend or mutating the child run record.
    let releaseChildLease;
    let childLeaseReady;
    const childLeaseReadyPromise = new Promise((resolve) => { childLeaseReady = resolve; });
    const childLease = h.withRunLease(cwd, childRunId, async () => {
      childLeaseReady();
      await new Promise((resolve) => { releaseChildLease = resolve; });
    });
    await childLeaseReadyPromise;
    // The callback has already entered before the parent scheduling tick.
    const childRecordPath = join(cwd, ".pi", "workflows", childRunId, "run.json");
    const childBytesBefore = readFileSync(childRecordPath, "utf8");
    const pollsBeforeLease = statusPolls.length;
    try {
      await h.scheduleRun(cwd, run.runId);
      assert.equal(statusPolls.length, pollsBeforeLease, "busy child lease defers backend poll");
      assert.equal(readFileSync(childRecordPath, "utf8"), childBytesBefore, "busy child lease prevents child mutation");
    } finally {
      releaseChildLease();
      await childLease;
    }

    // Once the child lease is released, the parent can reconcile it normally.
    await h.scheduleRun(cwd, run.runId);
    // The child supervisor's next tick refreshes stage one and schedules stage two.
    await h.scheduleRun(cwd, childRunId);

    for (let i = 0; i < 8 && (await h.readRunRecord(cwd, run.runId)).status !== "completed"; i++) {
      await h.scheduleRun(cwd, run.runId);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    current = await h.readRunRecord(cwd, run.runId);
    assert.equal(current.status, "completed", `parent=${JSON.stringify(current.tasks)} launched=${launched.length} polls=${statusPolls.length}`);
    assert.equal(launched.length, 2, "second sequential stage dispatched exactly once");
    assert.ok(statusPolls.length >= 2, "refresh polled backend status");
  } finally {
    setApi(undefined);
  }
});
