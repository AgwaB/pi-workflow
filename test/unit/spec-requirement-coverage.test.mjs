import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as h from "./unit-test-support.mjs";
import { loadWorkflowSpec } from "../../.tmp/unit/schema.js";
import { validateJsonSchema } from "../../.tmp/unit/json-schema.js";
import render from "../../workflows/spec-review/helpers/render-spec-review-report.mjs";
import {
  appendWorkflowArtifactReadLedger,
  readWorkflowArtifact,
} from "../../.tmp/unit/workflow-artifact-tool.js";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";

const citation = {
  file: "source.ts",
  lineStart: 1,
  lineEnd: 1,
  quote: "export const enabled = true;",
};
const candidate = {
  id: "finding-001",
  title: "Candidate gap",
  claim: "Gap",
  severity: "medium",
  requirementIds: ["REQ-001"],
  specEvidence: [],
  implementationEvidence: [],
  testEvidence: [],
  uncertainty: "Verify",
};
const positives = [
  "all-covered-drop",
  "all-covered-reordered-drop",
  "gap-keep",
  "gap-weaken",
  "partial-keep",
  "zero-clean",
  "uppercase-id",
  "report-risks",
];
const modes = [
  ...positives,
  "coverage-empty",
  "coverage-wrong-id",
  "coverage-missing",
  "coverage-duplicate",
  "coverage-missing-array",
  "coverage-missing-id",
  "coverage-invalid-id",
  "coverage-missing-status",
  "coverage-invalid-status",
  "extract-duplicate",
  "extract-invalid-id",
  "extract-empty",
  "extract-id-only",
  "gap-drop",
  "partial-drop",
  "unclear-keep",
  "unlinked-gap",
  "bad-extra-gap-citation",
  "bad-extra-positive-citation",
  "legacy-positive",
  "missing-proof",
  "saved-missing",
  "saved-stale",
  "saved-forged",
  "source-stale",
  "candidate-stale",
  "report-owner-mismatch",
  "needs-human-lineage",
  "sidecar-failure",
  "report-risks",
  "runtime-universe-forged",
  "unverified-spec-source",
  "needs-human-shape",
  "map-source-stale",
  "test-source-stale",
  "map-task-stale",
  "test-task-stale",
];

for (const mode of modes)
  test(`IRCF-01 real materialized coverage: ${mode}`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spec-coverage-"));
    let current;
    let sidecarRoot;
    try {
      h.writeAgent(cwd, "scout", "read, grep, find, ls");
      await writeFile(join(cwd, "source.ts"), `${citation.quote}\n`);
      await writeFile(join(cwd, "SPEC.md"), "The feature remains enabled.\n");
      const bundle = join(cwd, "workflows", "fixture");
      await mkdir(dirname(bundle), { recursive: true });
      await cp(resolve("workflows/spec-review"), bundle, { recursive: true });
      const specPath = join(bundle, "spec.json");
      const loaded = await loadWorkflowSpec(specPath, cwd);
      const compiled = await h.compileWorkflow(loaded.spec, {
        cwd,
        specPath,
        task: "Check exact extracted requirement IDs using local bytes; no provider.",
      });
      assert.deepEqual(compiled.warnings, []);
      const { run } = await h.createWorkflowRunRecord(cwd, compiled, specPath);
      current = run;
      await h.writeStaticRunArtifacts(cwd, run, compiled, loaded.spec);
      await h.writeRunRecord(cwd, run);
      const launches = [];
      h.setSubagentApiForTests({
        async runSubagent(options) {
          launches.push({
            agent: options.agent,
            model: options.model,
            tools: options.tools,
          });
          return {
            runId: `fake-${launches.length}`,
            attemptId: `attempt-${launches.length}`,
            status: "running",
          };
        },
        async getSubagentStatus() {
          return null;
        },
        async reconcileSubagentRun() {
          return {};
        },
        async interruptSubagent() {
          return {};
        },
      });
      const step = async () => {
        await h.writeRunRecord(cwd, current);
        current = await h.scheduleRun(cwd, run.runId);
        return current;
      };
      const path = (task) =>
        join(dirname(join(cwd, task.files.result)), "control.json");
      const read = async (task) =>
        JSON.parse(await readFile(path(task), "utf8"));
      const complete = async (task, control, malformed = false) => {
        assert.equal(task.status, "running", task.specId);
        const stage = loaded.spec.artifactGraph.stages.find(
          (row) => row.id === task.stageId,
        );
        const schema = JSON.parse(
          await readFile(join(bundle, stage.output.controlSchema), "utf8"),
        );
        // Deliberately malformed controls bypass model-output shape validation
        // to test helper defense in depth. The actual scheduler still writes
        // manifests/materializes tasks and validates support-helper outputs.
        if (!malformed)
          assert.deepEqual(
            validateJsonSchema(
              { schema: "stage-control-v1", digest: "fixture", ...control },
              schema,
            ),
            { valid: true, issues: [] },
          );
        await h.completeTask(cwd, task, control);
      };
      current = await step();
      const requirements = [
        {
          id: "REQ-001",
          requirement: "The feature remains enabled",
          specEvidence: {
            file: "SPEC.md",
            lineStart: 1,
            lineEnd: 1,
            quote: "The feature remains enabled."
          },
          ...(mode === "unverified-spec-source"
            ? { specEvidence: "NOT-A-REAL-SOURCE" }
            : {}),
          priority: "medium",
          implementationSignals: [],
          testSignals: [],
        },
      ];
      if (
        [
          "coverage-missing",
          "all-covered-reordered-drop",
          "coverage-same-count-wrong-set",
        ].includes(mode)
      )
        requirements.push({ ...requirements[0], id: "REQ-002" });
      if (mode === "extract-duplicate")
        requirements.push({ ...requirements[0] });
      if (mode === "extract-invalid-id") requirements[0].id = " REQ-001 ";
      if (mode === "unverified-spec-source") {
        requirements[0].specSources = ["MISSING-SPEC.md"];
      }
      if (mode === "extract-empty") requirements.length = 0;
      if (mode === "extract-id-only") requirements[0] = { id: "REQ-001" };
      const extractTask = h.taskBySpec(current, "extract-spec.main");
      await complete(
        extractTask,
        { specSources: ["SPEC.md"], requirements },
        mode === "extract-invalid-id" ||
          mode === "unverified-spec-source" ||
          mode === "extract-empty" ||
          mode === "extract-id-only",
      );
      await complete(h.taskBySpec(current, "map-implementation.main"), {
        implementationMap: [{ file: "source.ts", evidence: citation.quote }],
      });
      await complete(h.taskBySpec(current, "inspect-tests.main"), {
        testMap: [],
      });
      current = await step();
      const coverage = [
        { requirementId: "REQ-001", status: "covered", evidence: [citation] },
      ];
      if (
        [
          "gap-keep",
          "gap-weaken",
          "gap-drop",
          "unlinked-gap",
          "bad-extra-gap-citation",
        ].includes(mode)
      )
        coverage[0] = { requirementId: "REQ-001", status: "gap" };
      if (mode.startsWith("partial-")) coverage[0].status = "partial";
      if (mode === "unclear-keep") coverage[0].status = "unclear";
      if (
        [
          "all-covered-reordered-drop",
          "coverage-same-count-wrong-set",
        ].includes(mode)
      )
        coverage.unshift({ ...coverage[0], requirementId: "REQ-002" });
      if (mode === "coverage-empty") coverage.length = 0;
      if (mode === "coverage-wrong-id")
        coverage[0].requirementId = "REQ-NOT-EXTRACTED";
      if (mode === "coverage-same-count-wrong-set")
        coverage[0].requirementId = "REQ-NOT-EXTRACTED";
      if (mode === "coverage-duplicate") coverage.push({ ...coverage[0] });
      if (mode === "coverage-missing-id") {
        delete coverage[0].requirementId;
        coverage[0].id = "REQ-001";
      }
      if (mode === "coverage-invalid-id")
        coverage[0].requirementId = " REQ-001 ";
      if (mode === "coverage-missing-status") delete coverage[0].status;
      if (mode === "coverage-invalid-status") coverage[0].status = "CONFORMS";
      if (mode.startsWith("bad-extra-"))
        coverage[0].evidence = [citation, { ...citation, quote: "invented" }];
      if (mode === "legacy-positive") coverage[0].evidence = ["source.ts:1"];
      const actualCandidate =
        mode === "unlinked-gap"
          ? { ...candidate, requirementIds: ["REQ-NOT-EXTRACTED"] }
          : mode === "uppercase-id"
            ? { ...candidate, id: "F-001" }
            : candidate;
      const isZero = mode === "zero-clean";
      const candidateControl = {
        candidateFindings: isZero ? [] : [actualCandidate],
        requirementCoverage: coverage,
        needsHuman: mode === "needs-human-shape" ? [{ reason: "opaque uncertainty" }] : [],
        noIssueNotes: [],
      };
      if (mode === "coverage-missing-array")
        delete candidateControl.requirementCoverage;
      const candidateTask = h.taskBySpec(current, "candidate-findings.main");
      await complete(
        candidateTask,
        candidateControl,
        [
          "coverage-missing-array",
          "coverage-missing-id",
          "coverage-invalid-id",
          "coverage-missing-status",
          "coverage-invalid-status",
        ].includes(mode),
      );
      current = await step();
      const verifier = current.tasks.find(
        (task) =>
          task.foreachGenerated?.placeholderSpecId === "verify-findings.item",
      );
      const keep = [
        "gap-keep",
        "gap-weaken",
        "partial-keep",
        "unclear-keep",
        "unlinked-gap",
        "bad-extra-gap-citation",
      ].includes(mode);
      if (!isZero) {
        assert.equal(
          verifier.foreachGenerated.itemIdentity,
          actualCandidate.id,
        );
        await complete(verifier, {
          id: actualCandidate.id,
          verdict:
            mode === "needs-human-lineage"
              ? "NEEDS_HUMAN"
              : keep
                ? mode === "gap-weaken"
                  ? "WEAKEN"
                  : "KEEP"
                : "DROP",
          severity: "medium",
          evidence: keep ? [citation] : [],
          counterEvidence: keep ? [] : [citation],
          finalClaim:
            mode === "needs-human-lineage" ? "Distinct human claim" : "Fixture",
          recommendedAction:
            mode === "needs-human-lineage" ? "Distinct next action" : "Inspect",
        });
      }
      if (mode === "missing-proof")
        await rm(join(dirname(path(candidateTask)), "source-manifest.json"));
      current = await step();
      const partitionTask = h.taskBySpec(current, "partition-findings.main");
      assert.equal(partitionTask.status, "completed");
      const p = await read(partitionTask);
      if (isZero) {
        assert.deepEqual(p.verifierCoverage.ownerLedger, []);
        assert.deepEqual(p.verifierCoverage.verifierRows, []);
        assert.equal(p.verifierCoverage.ownerLedgerReconciliation.passed, true);
        assert.deepEqual(p.evidenceGate.findings, []);
      } else {
        const owner = p.verifierCoverage.ownerLedger[0];
        assert.equal(owner.taskId, verifier.taskId);
        assert.equal(owner.specId, verifier.specId);
        assert.equal(owner.itemIdentity, actualCandidate.id);
        assert.equal(p.verifierCoverage.ownerLedgerReconciliation.passed, true);
        if (p.evidenceGate.requirementReconciliation.proof) {
          assert.equal(typeof p.evidenceGate.requirementReconciliation.proof.mapTaskId, "string");
          assert.equal(typeof p.evidenceGate.requirementReconciliation.proof.mapControlSha256, "string");
          assert.equal(typeof p.evidenceGate.requirementReconciliation.proof.inspectTestsTaskId, "string");
          assert.equal(typeof p.evidenceGate.requirementReconciliation.proof.inspectTestsControlSha256, "string");
        }
        if (mode === "needs-human-lineage") {
          assert.equal(p.evidenceGate.findings[0].complete, false);
        } else {
          assert.equal(p.evidenceGate.findings[0].complete, true);
          assert.equal(p.evidenceGate.findings[0].rows[0].status, "verified");
        }
      }
      const pristine = structuredClone(p);
      if (mode === "saved-missing")
        delete p.evidenceGate.requirementReconciliation;
      if (mode === "saved-stale")
        p.requirementCoverage[0].requirementId = "REQ-OLD";
      if (mode === "saved-forged")
        p.evidenceGate.requirementReconciliation = {
          ...(p.evidenceGate.requirementReconciliation ?? {}),
          complete: true,
          requirementIds: ["REQ-FORGED"],
        };
      if (mode === "source-stale") {
        const value = await read(extractTask);
        value.requirements[0].requirement = "Changed control bytes, same IDs";
        await writeFile(path(extractTask), JSON.stringify(value));
      }
      if (mode === "map-source-stale" || mode === "test-source-stale") {
        const stageId = mode === "map-source-stale" ? "map-implementation" : "inspect-tests";
        const task = h.taskBySpec(current, `${stageId}.main`);
        const value = await read(task);
        value.digest = "Changed control bytes, same task identity";
        await writeFile(path(task), JSON.stringify(value));
      }
      if (mode === "map-task-stale" || mode === "test-task-stale") {
        const stageId = mode === "map-task-stale" ? "map-implementation" : "inspect-tests";
        const manifestPath = join(dirname(path(candidateTask)), "source-manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        const source = manifest.sources.find((row) => row.stageId === stageId);
        source.taskId = `replaced-${stageId}-task`;
        await writeFile(manifestPath, JSON.stringify(manifest));
      }
      if (mode === "candidate-stale") {
        const value = await read(candidateTask);
        value.requirementCoverage = [];
        await writeFile(path(candidateTask), JSON.stringify(value));
      }
      if (mode === "runtime-universe-forged") {
        p.verifierCoverage.candidateUniverse = {
          ...p.verifierCoverage.candidateUniverse,
          count: 0,
          uniqueCount: 0,
          ids: [],
          duplicateIds: [],
          invalidRowCount: 0,
        };
        p.verifierCoverage.candidateCount = 0;
        p.verifierCoverage.uniqueCandidateCount = 0;
        p.verifierCoverage.verifierCount = 0;
        p.verifierCoverage.uniqueVerifierCount = 0;
        p.verifierCoverage.verifiedCandidateCount = 0;
        p.verifierCoverage.ownerLedger = [];
        p.verifierCoverage.verifierRows = [];
        p.verifierCoverage.ownerLedgerReconciliation = {
          ...p.verifierCoverage.ownerLedgerReconciliation,
          ownerRowCount: 0,
          verifierRowCount: 0,
          ownerIds: [],
          verifierIds: [],
          passed: true,
          cardinalityPassed: true,
        };
        p.verdictCounts = {
          keep: 0,
          weaken: 0,
          drop: 0,
          needsHuman: 0,
          missingVerification: 0,
          invalidVerifier: 0,
          orphanVerifier: 0,
        };
        p.finalFindings = [];
        p.droppedFindings = [];
        p.needsHuman = [];
        p.readProjection = {
          candidateIds: [],
          requirementIds: [],
          finalIds: [],
          droppedIds: [],
          needsHumanIds: [],
        };
      }
      if (mode.startsWith("saved-"))
        await writeFile(path(partitionTask), JSON.stringify(p));
      // Follow the canonical gate rather than forcing an inconsistent negative
      // narrative. On the vulnerable baseline the bypasses actually pass.
      const expectedVerdict =
        p.evidenceGate.requirementReconciliation?.complete === false ||
        mode === "missing-proof"
          ? "INCONCLUSIVE"
          : keep
            ? "GAPS_FOUND"
            : "CONFORMS";
      const report = {
        schema: "spec-review-report-v1",
        summary: "Coverage fixture",
        verdict:
          mode === "needs-human-lineage" ? "NEEDS_HUMAN" : expectedVerdict,
        ownerLedger: p.verifierCoverage.ownerLedger,
        ownerLedgerReconciliation: p.verifierCoverage.ownerLedgerReconciliation,
        risks:
          mode === "report-risks"
            ? Array.from({ length: 12 }, (_, index) => `Risk ${index + 1}`)
            : [],
        recommendedNextAction: "Inspect",
      };
      if (mode === "report-owner-mismatch") {
        report.ownerLedger = [];
        report.ownerLedgerReconciliation = {
          ...p.verifierCoverage.ownerLedgerReconciliation,
          passed: false,
        };
      }
      await complete(h.taskBySpec(current, "report.main"), report);
      // Independent renderer invocation uses genuine scheduler identities and
      // manifests too: runtime tamper detection must not be the only rejection.
      const directTaskId = "direct-render-task";
      if (mode === "sidecar-failure") {
        sidecarRoot = await mkdtemp(join(tmpdir(), "spec-sidecar-"));
        await writeFile(join(sidecarRoot, ".pi"), "not a directory");
      }
      const direct = await render({
        sources: { "partition-findings": p, report },
        context: {
          cwd: sidecarRoot ?? cwd,
          runId: run.runId,
          taskId: directTaskId,
          sourceStatuses: [
            partitionTask,
            h.taskBySpec(current, "report.main"),
          ].map((task) => ({
            source: task.stageId,
            stageId: task.stageId,
            specId: task.specId,
            taskId: task.taskId,
            status: "completed",
          })),
        },
      });
      current = await step();
      const final = h.taskBySpec(current, "final.main");
      let result;
      try {
        result = await read(final);
      } catch {}
      const summary = {
        mode,
        runId: run.runId,
        launches,
        partition: pristine,
        direct: {
          status: direct.status,
          verdict: direct.verdict,
          gates: direct.gates,
        },
        finalTaskStatus: final.status,
        final: result ?? null,
      };

      if (process.env.COVERAGE_FINAL_EVIDENCE_DIR) {
        const destination = join(process.env.COVERAGE_FINAL_EVIDENCE_DIR, mode);
        await mkdir(destination, { recursive: true });
        await cp(
          join(cwd, ".pi", "workflows", run.runId),
          join(destination, run.runId),
          { recursive: true },
        );
        await writeFile(
          join(destination, "summary.json"),
          `${JSON.stringify(summary, null, 2)}\n`,
        );
      }
      const passed = positives.includes(mode);
      assert.equal(
        direct.status,
        passed ? "passed" : "failed",
        "independent renderer",
      );
      if (passed) {
        assert.equal(result?.status, "passed");
        assert.equal(result.verdict, expectedVerdict);
        assert.equal(current.tasks.length, isZero ? 8 : 9);
        assert.equal(
          current.tasks.filter((task) => task.status === "completed").length,
          isZero ? 8 : 9,
        );
      } else {
        if (mode !== "sidecar-failure")
          assert.notEqual(result?.status, "passed");
        assert.equal(
          direct.verdict,
          mode === "report-owner-mismatch"
            ? "CONFORMS"
            : ["needs-human-lineage", "needs-human-shape"].includes(mode)
              ? "NEEDS_HUMAN"
              : "INCONCLUSIVE",
        );
      }
      if (mode === "needs-human-shape") {
        const row = pristine.needsHuman[0];
        assert.equal(typeof row.reason, "string");
        assert.equal(typeof row.uncertainty, "string");
        assert.equal(typeof row.finalClaim, "string");
        assert.equal(typeof row.recommendedAction, "string");
        assert.equal(typeof row.origin?.kind, "string");
        assert.ok(Array.isArray(row.requirementIds));
      }
      if (mode === "needs-human-lineage") {
        assert.match(direct.markdown, /Distinct human claim/);
        assert.match(direct.markdown, /Distinct next action/);
        assert.match(direct.markdown, /Original candidate/);
        assert.match(direct.markdown, /Verifier record/);
      }
      if (mode === "sidecar-failure") {
        assert.match(direct.blockers.join(" "), /sidecar publication failed/);
        assert.equal(direct.gates.passed, false);
      }
      if (mode === "report-risks") {
        assert.match(direct.markdown, /Risk 12/);
        const ledger = await readFile(
          join(
            cwd,
            ".pi",
            "workflows",
            run.runId,
            "tasks",
            directTaskId,
            "source-ledger.json",
          ),
          "utf8",
        );
        assert.match(ledger, /Risk 12/);
      }
      if (
        !mode.startsWith("saved-") &&
        ![
          "source-stale",
          "candidate-stale",
          "report-owner-mismatch",
          "sidecar-failure",
          "runtime-universe-forged",
          "map-source-stale",
          "test-source-stale",
          "map-task-stale",
          "test-task-stale",
        ].includes(mode)
      )
        assert.equal(pristine.evidenceGate.complete, passed);
    } finally {
      h.setSubagentApiForTests(undefined);
      await rm(cwd, { recursive: true, force: true });
      if (sidecarRoot) await rm(sidecarRoot, { recursive: true, force: true });
    }
  });

function escapedText(length) {
  const alphabet = ['"', "\\", "\u0001", "é"];
  return Array.from({ length }, (_, index) => alphabet[index % alphabet.length]).join("");
}

function worstEscapedText(length) {
  return "\u0001".repeat(length);
}

function maxCitation() {
  return {
    file: worstEscapedText(240),
    lineStart: 9007199254740991,
    lineEnd: 9007199254740991,
    quote: worstEscapedText(240),
    relevance: worstEscapedText(240),
  };
}

function maxRequirement(index) {
  return {
    id: `REQ-${String(index + 1).padStart(3, "0")}${escapedText(89)}`,
    requirement: worstEscapedText(512),
    specEvidence: [maxCitation(), maxCitation(), maxCitation(), maxCitation()],
    priority: "info",
    implementationSignals: Array.from({ length: 4 }, () => worstEscapedText(80)),
    testSignals: Array.from({ length: 4 }, () => worstEscapedText(80)),
  };
}

function maxMapRow() {
  return {
    component: worstEscapedText(240),
    file: worstEscapedText(240),
    evidence: worstEscapedText(400),
    observedBehavior: worstEscapedText(400),
    relatedSignals: Array.from({ length: 8 }, () => worstEscapedText(80)),
  };
}

function maxTestRow() {
  return {
    testOrFixture: worstEscapedText(240),
    file: worstEscapedText(240),
    evidence: worstEscapedText(400),
    coveredBehavior: worstEscapedText(400),
    relatedSignals: Array.from({ length: 8 }, () => worstEscapedText(80)),
  };
}

function maxProjectionIds(count) {
  return Array.from({ length: count }, (_, index) =>
    `${String(index + 1).padStart(3, "0")}${worstEscapedText(93)}`,
  );
}

test("SR-FINAL-S07 escaped max-schema projections and empty tails stay readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "spec-projection-budget-"));
  try {
    const loaded = await loadWorkflowSpec(resolve("workflows/spec-review/spec.json"), root);
    const stages = loaded.spec.artifactGraph.stages;
    const input = (stageId) => stages.find((stage) => stage.id === stageId).inputPolicy;
    const extract = {
      schema: escapedText(1200),
      digest: escapedText(1200),
      specSources: Array.from({ length: 8 }, (_, index) =>
        index % 2 === 0 ? escapedText(240) : { kind: "local", file: escapedText(240) },
      ),
      requirements: Array.from({ length: 40 }, (_, index) => maxRequirement(index)),
    };
    const singleCitationExtract = {
      ...extract,
      requirements: [{ ...maxRequirement(0), specEvidence: maxCitation() }],
    };
    const map = {
      schema: escapedText(1200),
      digest: escapedText(1200),
      implementationMap: Array.from({ length: 60 }, () => maxMapRow()),
      unmappedAreas: Array.from({ length: 40 }, () => escapedText(240)),
      notes: Array.from({ length: 40 }, () => escapedText(240)),
    };
    const tests = {
      schema: escapedText(1200),
      digest: escapedText(1200),
      testMap: Array.from({ length: 60 }, () => maxTestRow()),
      coverageGapsSuspected: Array.from({ length: 40 }, () => escapedText(240)),
      notes: Array.from({ length: 40 }, () => escapedText(240)),
    };
    const partition = {
      readProjection: {
        candidateIds: maxProjectionIds(30),
        requirementIds: maxProjectionIds(40),
        finalIds: maxProjectionIds(64),
        droppedIds: maxProjectionIds(64),
        needsHumanIds: maxProjectionIds(256),
      },
    };
    const sources = [
      ["extract-spec", extract],
      ["map-implementation", map],
      ["inspect-tests", tests],
      ["partition-findings", partition],
    ];
    for (const [stageId, control] of [["extract-spec", extract], ["extract-spec", singleCitationExtract], ["map-implementation", map], ["inspect-tests", tests]]) {
      const stage = stages.find((row) => row.id === stageId);
      const schema = JSON.parse(await readFile(resolve("workflows/spec-review", stage.output.controlSchema), "utf8"));
      assert.deepEqual(
        validateJsonSchema(control, schema),
        { valid: true, issues: [] },
        `${stageId} escaped max-schema control`,
      );
    }
    const readAll = async (variant, values) => {
      const taskDir = join(root, variant);
      await mkdir(taskDir, { recursive: true });
      const manifest = {
        schema: "workflow-source-manifest-v1",
        runId: `run-${variant}`,
        taskId: `task-${variant}`,
        sources: [],
      };
      for (const [source] of sources) {
        const path = join(taskDir, `${source}.control.json`);
        await writeFile(path, JSON.stringify(values[source]));
        manifest.sources.push({
          source,
          taskId: `source-${source}`,
          stageId: source,
          specId: `${source}.main`,
          artifacts: { control: { path } },
        });
      }
      const reads = [
        ["extract-spec", input("candidate-findings")],
        ["map-implementation", input("candidate-findings")],
        ["inspect-tests", input("candidate-findings")],
        ["partition-findings", input("report")],
      ];
      let largest = { source: "", path: "", chars: 0 };
      for (const [source, policy] of reads) {
        const requiredReads = policy.requiredReads.filter((required) => required.source === source);
        const requiredReadPolicy = policy.requiredReadPolicy.filter((required) => required.source === source);
        for (const required of requiredReads) {
          const result = await readWorkflowArtifact(manifest, source, "control", {
            path: required.path,
            maxItems: required.maxItems,
            maxChars: required.maxChars,
          });
          assert.equal(result.truncated, false, `${variant}:${source}:${required.path}`);
          largest = result.projection.originalChars > largest.chars
            ? { source, path: result.projection.path, chars: result.projection.originalChars }
            : largest;
          await appendWorkflowArtifactReadLedger(join(taskDir, "read-ledger.jsonl"), {
            schema: "workflow-artifact-read-v1",
            runId: manifest.runId,
            taskId: manifest.taskId,
            source,
            artifact: "control",
            at: new Date().toISOString(),
            bytes: result.bytes,
            returnedBytes: result.returnedBytes,
            truncated: result.truncated,
            path: result.projection.path,
            maxItems: required.maxItems,
            maxChars: required.maxChars,
          });
        }
        const check = await checkRequiredArtifactReads(
          taskDir,
          requiredReads,
          requiredReadPolicy,
        );
        assert.deepEqual(check, { missing: [], projectionFailures: [] }, `${variant}:${source}`);
      }
      return largest;
    };
    const values = {
      "extract-spec": extract,
      "map-implementation": map,
      "inspect-tests": tests,
      "partition-findings": partition,
    };
    const maximum = await readAll("max", values);
    await readAll("single-citation", { ...values, "extract-spec": singleCitationExtract });
    const empty = {
      "extract-spec": { ...extract, requirements: [maxRequirement(0)] },
      "map-implementation": { ...map, implementationMap: [] },
      "inspect-tests": { ...tests, testMap: [] },
      "partition-findings": { readProjection: {
        candidateIds: [], requirementIds: [], finalIds: [], droppedIds: [], needsHumanIds: [],
      } },
    };
    const emptyTail = await readAll("empty-tail", empty);
    assert.ok(maximum.chars > 12000, `escaped maximum must exercise the prior cap: ${maximum.chars}`);
    assert.ok(maximum.chars < 100000, `workflow-specific cap must be adequate: ${maximum.chars}`);
    assert.ok(emptyTail.chars > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
