// Provider-free host fixtures, NOT real user/worker/verifier authentication.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const build = resolve(process.env.GOAL_HEADLESS_HOST_TEST_BUILD_ROOT ?? ".tmp/unit");
const { createGoalHostIngress, goalHash, humanGoalRequestHash } = await import(
  pathToFileURL(join(build, "goal-contract.js")),
);
const { GoalStore } = await import(pathToFileURL(join(build, "goal-store.js")));
export { createGoalHostIngress, goalHash, GoalStore };
export const h = (value) => goalHash({ fixture: value });
export const user = { kind: "user", id: "owner-user" };
export const hostActor = { kind: "host", id: "fixture-host" };
export function contractData(options = {}) {
  const roles = [
    "planning",
    "research-execution",
    "verification",
    "synthesis",
    "final-judgment",
  ].map((role) => ({
    role,
    model: "fixture/model",
    thinking: "high",
    origin: { model: "fixed", thinking: "fixed" },
  }));
  const profile = {
    schemaVersion: 1,
    name: "fixture",
    source: "custom",
    templateFingerprint: h("template"),
    environmentDigest: h("profile-env"),
    roles,
  };
  const authority = {
    schemaVersion: 1,
    goalId: "fixture-goal",
    revision: 1,
    issuer: user.id,
    actorReceipt: h("user-receipt"),
    scopeDigest: h("scope"),
    allowedEffects: ["read", "verify", "candidate-write", "origin-apply"],
    roots: ["fixture-root"],
    protectedPaths: ["fixture-control"],
    applyMode: "confirm",
    backgroundAllowed: false,
    resumePredicates: ["dependency-healthy"],
    revocationGeneration: 0,
  };
  return {
    schemaVersion: 1,
    goalId: authority.goalId,
    revision: 1,
    previousHash: null,
    requestDigest: h("request"),
    subjectScope: ["fixture-report"],
    criteria: [criterion("objective")],
    authority,
    authorityHash: goalHash(authority),
    profile,
    profileHash: goalHash(profile),
    executionMode: "foreground",
    completionTarget: "artifact",
    limits: { requests: null, costMicros: null },
    exclusions: ["push", "release", "credentials"],
    ...options,
  };
}
export function criterion(id, kind = "deterministic", target = "artifact") {
  return {
    id,
    statement: `Fixture ${id} required`,
    required: true,
    kind,
    binding: {
      subjectDigest: h("subject"),
      environmentDigest: h("environment"),
      verifierId: kind === "human" ? user.id : "fixture-verifier",
      producerLineageDigest: h(`lineage-${id}`),
      codeDigest: h("code"),
      configDigest: h("config"),
      target,
    },
    acceptanceDigest: h(`acceptance-${id}`),
    maxAgeMs: 1000,
  };
}
export function fixture(options = {}) {
  const ingress = createGoalHostIngress();
  const contract = ingress.contract(contractData(options), user);
  const obsData = {
    schemaVersion: 1,
    at: 100,
    effectsKnown: true,
    effects: [],
    bindings: contract.criteria.map((c) => ({
      criterionId: c.id,
      binding: c.binding,
    })),
  };
  let n = 0;
  const obs = (changes) => ingress.observations({ ...obsData, ...changes });
  const event = (type, fields = {}, actor = hostActor, inventory = obsData) =>
    ingress.event(
      {
        schemaVersion: 1,
        id: `event-${++n}`,
        contractHash: goalHash(contract),
        type,
        ...fields,
      },
      actor,
      inventory,
    );
  const receipt = (c = contract.criteria[0], changes = {}) => {
    const r = {
      schemaVersion: 1,
      id: `receipt-${++n}`,
      contractHash: goalHash(contract),
      criterionId: c.id,
      binding: c.binding,
      kind: c.kind,
      acceptanceDigest: c.acceptanceDigest,
      result: "pass",
      observedAt: 90,
      validUntil: 1000,
      evidenceRefs: [h("evidence")],
      producer: {
        id: c.binding.verifierId,
        lineageDigest: c.binding.producerLineageDigest,
      },
      model:
        c.kind === "model-rubric"
          ? {
              model: "fixture/model",
              thinking: "high",
              accessDigest: h("access"),
              judgment: "Fixture rubric accepts; not objective proof.",
              counterexamples: [],
              limitations: ["Synthetic fixture only"],
            }
          : null,
      humanRequestHash:
        c.kind === "human"
          ? humanGoalRequestHash(goalHash(contract), c.id, c.binding)
          : null,
      ...changes,
    };
    return event(
      "receipt",
      { receipt: r },
      { kind: r.kind === "human" ? "user" : "verifier", id: r.producer.id },
    );
  };
  const terminal = (lifecycle = "achieved", changes = {}) =>
    event("terminal", { lifecycle, at: 100 }, hostActor, {
      ...obsData,
      ...changes,
    });
  return { ingress, contract, obsData, obs, event, receipt, terminal };
}
export function blocker(id = "blocker-1", changes = {}) {
  return {
    id,
    criterionId: "objective",
    errorClass: "dependency",
    resource: "fixture-service",
    predicateId: "dependency-healthy",
    instanceDigest: h(id),
    diagnosis: "Fixture dependency unavailable",
    requiredInput: "Trusted health observation",
    ...changes,
  };
}

// Actual separate OS processes exercise exclusive publication/crash windows.
// IPC barriers, not sleeps, determine the race. This never starts a Goal runtime.
if (process.argv[2] === "store-writer") {
  const [root, expectedJson, mode] = process.argv.slice(3);
  const expected = JSON.parse(expectedJson);
  const f = fixture();
  const store = new GoalStore(root, {
    fault: async (point) => {
      if (point === mode) {
        process.send?.({ type: "barrier", point });
        if (mode === "file-synced")
          await new Promise((resolve) => process.once("message", resolve));
        else process.exit(73);
      }
    },
  });
  process.send?.({ type: "ready" });
  await new Promise((resolve) => process.once("message", resolve));
  try {
    const result = await store.commitEvent(
      store.hostOwner("owner-a", 0),
      expected,
      f.event("note", { text: `writer ${process.pid}` }),
    );
    process.send?.({
      type: "result",
      status: "ok",
      seq: result.seq,
      hash: result.hash,
    });
    process.disconnect?.();
  } catch (error) {
    process.send?.({
      type: "result",
      status: "rejected",
      error: String(error),
    });
    process.disconnect?.();
  }
}
