import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseGoalContract,
  parseGoalEvent,
  parseGoalReceipt,
  goalJson,
  parseGoalProfile,
  parseGoalAuthority,
  assertGoalRevision,
} from "../../.tmp/unit/goal-contract.js";
import { parseWorkflow } from "../../.tmp/unit/schema.js";
import {
  goalInput,
  goalWorkflowHash,
  encodeGoalWorkflowDataRecord,
  decodeGoalWorkflowDataRecord,
  parseGoalJsonTextWithCanonical,
} from "../../.tmp/unit/goal-json.js";
import { parseArtifactGraphWorkflowSpec } from "../../.tmp/unit/artifact-graph-schema.js";
import { reduceGoal } from "../../.tmp/unit/goal-decision.js";
import {
  contractData,
  createGoalHostIngress,
  fixture,
  goalHash,
  h,
  user,
  criterion,
} from "./helpers/goal-fixture.mjs";

const clone = structuredClone;
test("Workflow data hashing preserves finite fractions without relaxing authority JSON", () => {
  assert.equal(goalWorkflowHash({ value: 0.5 }),
    createHash("sha256").update('{"value":0.5}', "utf8").digest("hex"));
  const integerData = { name: "원본", stages: [{ index: 2, enabled: true }], limit: null };
  assert.equal(goalWorkflowHash(integerData), goalHash(integerData));
  assert.throws(() => goalHash({ value: 0.5 }));
  assert.throws(() => goalJson({ value: 0.5 }));
  assert.throws(() => goalInput({ value: 0.5 }));
});

test("Workflow data hashing retains zero-hook validation and source limits", () => {
  let hooks = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true, get() { hooks++; return 0.5; },
  });
  const proxy = new Proxy({ value: 0.5 }, {
    get() { hooks++; return 0.5; },
    ownKeys() { hooks++; return ["value"]; },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const invalid of [accessor, proxy, cycle, NaN, Infinity, -Infinity,
    { value: undefined }, new Date(), [, 1], "x".repeat(16_385)]) {
    assert.throws(() => goalWorkflowHash(invalid));
  }
  assert.equal(hooks, 0);
});

test("Workflow data records round-trip finite fractions across surrogate-safe chunks", () => {
  const value = { data: "x".repeat(16_374) + "𝄞", ratio: 0.5, nested: [0.25, -0.5] };
  const record = encodeGoalWorkflowDataRecord(value);
  assert.equal(record.schema, "goal-workflow-data/v1");
  assert.equal(record.chunks.length, 2);
  assert.equal(record.chunks[0].length, 16_383);
  assert.ok(record.chunks[1].startsWith("𝄞"), "a surrogate pair must not be split between journal strings");
  assert.deepEqual(decodeGoalWorkflowDataRecord(record), value);
  assert.doesNotThrow(() => goalJson(record));
});

test("Workflow data records reject tampering and unsafe input without hooks", () => {
  const record = encodeGoalWorkflowDataRecord({ value: 0.5 });
  for (const invalid of [
    null, [], 1,
    { ...record, extra: true },
    { ...record, chunks: [record.chunks.join("") + " "] },
    { ...record, chunks: ["{\"value\":5e-1}"] },
    { ...record, chunks: ["{\"value\":0.5}", ""] },
    { schema: record.schema, chunks: ["x".repeat(16_385)] },
    { schema: record.schema, chunks: Array(17).fill("0") },
    { ...record, chunks: ["{\"value\":", "0.5}"] },
  ]) assert.throws(() => decodeGoalWorkflowDataRecord(invalid));
  let hooks = 0;
  const proxy = new Proxy(record, {
    get() { hooks++; throw new Error("hook"); },
    ownKeys() { hooks++; throw new Error("hook"); },
  });
  assert.throws(() => decodeGoalWorkflowDataRecord(proxy));
  assert.throws(() => encodeGoalWorkflowDataRecord(proxy));
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true, get() { hooks++; throw new Error("hook"); },
  });
  assert.throws(() => encodeGoalWorkflowDataRecord(accessor));
  assert.throws(() => decodeGoalWorkflowDataRecord(accessor));
  const cycle = {}; cycle.value = cycle;
  for (const invalid of [cycle, { value: NaN }, { value: Infinity }, { value: -Infinity },
    { value: "x".repeat(16_385) }, Array(20_001).fill(0)]) {
    assert.throws(() => encodeGoalWorkflowDataRecord(invalid));
  }
  for (const text of [JSON.stringify({ value: "x".repeat(16_385) }),
    JSON.stringify(Array(20_001).fill(0)), "[".repeat(25) + "0" + "]".repeat(25)]) {
    const chunks = [];
    for (let offset = 0; offset < text.length; offset += 16_384)
      chunks.push(text.slice(offset, offset + 16_384));
    assert.throws(() => decodeGoalWorkflowDataRecord({ schema: record.schema, chunks }),
      "encoding must not bypass the original parsed-source limits");
  }
  assert.equal(hooks, 0);
});

test("A01 A06 R06 CORE clear contract: frozen identity, no numeric-budget ceremony, admission proposal only", () => {
  const f = fixture();
  assert.ok(Object.isFrozen(f.contract.criteria[0].binding));
  assert.throws(() => {
    f.contract.criteria.length = 0;
  });
  const d = reduceGoal(f.contract, [f.event("start")], f.obs());
  assert.equal(d.lifecycle, "running");
  assert.equal(d.criteria.length, 1);
  assert.deepEqual(d.proposals, [{ type: "admit", criterionId: "objective" }]);
  assert.equal(f.contract.limits.requests, null);
});
test("Goal limits accept zero and null only as bounded natural-number caps", () => {
  const data = contractData();
  data.limits = { requests: 0, costMicros: 0 };
  assert.deepEqual(parseGoalContract(data).limits, data.limits);
  for (const limits of [
    { requests: -1, costMicros: 0 },
    { requests: 0.5, costMicros: 0 },
    { requests: 0, costMicros: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const invalid = contractData();
    invalid.limits = limits;
    assert.throws(() => parseGoalContract(invalid));
  }
  const unlimited = contractData();
  unlimited.limits = { requests: null, costMicros: null };
  assert.deepEqual(parseGoalContract(unlimited).limits, unlimited.limits);
});
test("A02 CORE unresolved success target waits for clarification, not automatic apply", () => {
  const f = fixture({ completionTarget: "unresolved" });
  const d = reduceGoal(f.contract, [f.event("start")], f.obs());
  assert.equal(d.lifecycle, "waiting_user");
  assert.equal(d.proposals[0].type, "clarify-target");
  assert.throws(() =>
    reduceGoal(
      f.contract,
      [f.event("start"), f.receipt(), f.terminal()],
      f.obs(),
    ),
  );
});
test("A03 A05 B09 CORE serialized contract/events/approval never acquire host capability", () => {
  const f = fixture();
  const originalHash = goalHash(f.contract);
  assert.throws(
    () => reduceGoal(parseGoalContract(f.contract), [], f.obs()),
    /host user ingress/,
  );
  const accepted = f.event("start");
  for (const fake of [
    clone(accepted),
    JSON.parse(JSON.stringify(accepted)),
    { ...accepted, trusted: true },
  ]) {
    assert.throws(
      () => reduceGoal(f.contract, [fake], f.obs()),
      /host ingress/,
    );
  }
  assert.throws(
    () => reduceGoal(f.contract, [], clone(f.obs())),
    /host ingress/,
  );
  assert.throws(
    () =>
      f.ingress.event(
        { ...accepted.data, type: "control", action: "cancel" },
        { kind: "host", id: "worker" },
        f.obsData,
      ),
    /user ingress/,
  );
  assert.throws(
    () => f.ingress.contract(f.contract, { kind: "user", id: "impostor" }),
    /issuer mismatch/,
  );
  assert.equal(goalHash(f.contract), originalHash);
});
test("A04 CORE explicit user revision binds predecessor/authority/profile; old receipt stale and terminal immutable", () => {
  const f = fixture();
  const next = clone(f.contract);
  next.revision++;
  next.previousHash = goalHash(f.contract);
  next.authority.revision++;
  next.authorityHash = goalHash(next.authority);
  next.criteria[0].statement = "Owner explicitly revised acceptance";
  next.criteria[0].acceptanceDigest = h("new-acceptance");
  assertGoalRevision(f.contract, parseGoalContract(next));
  const events = [
    f.event("start"),
    f.receipt(),
    f.event("revision", { contract: next }, user),
  ];
  const d = reduceGoal(f.contract, events, f.obs());
  assert.equal(d.criteria[0].state, "stale");
  assert.equal(d.contractHash, goalHash(next));
  assert.throws(
    () =>
      reduceGoal(
        f.contract,
        [
          f.event("start"),
          f.receipt(),
          f.terminal(),
          f.event("revision", { contract: next }, user),
        ],
        f.obs(),
      ),
    /terminal is immutable/,
  );
  next.profile.roles[0].model = "changed-model";
  next.profileHash = goalHash(next.profile);
  assert.throws(
    () => assertGoalRevision(f.contract, parseGoalContract(next)),
    /profile/,
  );
});

test("A07 CORE delegation schema does not grant push/release/credential or background authority", () => {
  for (const effect of ["push", "release", "credentials", "shell"]) {
    const c = contractData();
    c.authority.allowedEffects.push(effect);
    c.authorityHash = goalHash(c.authority);
    assert.throws(() => parseGoalContract(c));
  }
  assert.throws(
    () => parseGoalContract(contractData({ executionMode: "background" })),
    /background/,
  );
});
test("A07 CORE parser rejects exact allowed-effect exclusions", () => {
  const c = contractData();
  c.exclusions.push("origin-apply is forbidden outside the selected scope");
  assert.doesNotThrow(() => parseGoalContract(c));
  c.exclusions.push("origin-apply");
  assert.throws(() => parseGoalContract(c), /both allowed and excluded/);
});
test("A08 CORE strict records reject unknown keys/version, duplicate IDs, empty acceptance, bounds and malformed JSON", () => {
  const c = contractData();
  const missingLineage = clone(c);
  delete missingLineage.criteria[0].binding.producerLineageDigest;
  const mutants = [
    { ...c, schemaVersion: 2 },
    { ...c, extra: true },
    missingLineage,
    { ...c, criteria: [] },
    { ...c, criteria: [c.criteria[0], c.criteria[0]] },
    { ...c, criteria: [{ ...c.criteria[0], required: false }] },
    { ...c, subjectScope: [] },
    { ...c, requestDigest: "bad" },
    { ...c, authorityHash: h("wrong") },
    { ...c, profileHash: h("wrong") },
    { ...c, previousHash: h("wrong") },
  ];
  for (const m of mutants) assert.throws(() => parseGoalContract(m));
  assert.throws(
    () =>
      parseGoalContract(
        JSON.stringify(c).replace(
          '"schemaVersion":1',
          '"schemaVersion":1,"schemaVersion":1',
        ),
      ),
    /duplicate/,
  );
  assert.throws(() => parseGoalContract(" ".repeat(300000)), /byte limit/);
  assert.throws(() => parseGoalContract('{"a":'));
  assert.throws(
    () =>
      parseGoalProfile({
        ...c.profile,
        roles: Array(5).fill(c.profile.roles[0]),
      }),
    /duplicate/,
  );
  assert.throws(() => parseGoalAuthority({ ...c.authority, roots: [] }));
  assert.throws(
    () =>
      parseGoalContract(
        contractData({
          criteria: [criterion("origin")],
          completionTarget: "origin",
        }),
      ),
    /origin criterion/,
  );
});
test("A08 B09 CORE receipt and event parsing reject trusted flags and unknown producers at ingress", () => {
  const f = fixture();
  const r = f.receipt().data.receipt;
  assert.throws(() => parseGoalReceipt({ ...r, trusted: true }));
  assert.throws(() =>
    parseGoalEvent({ ...f.event("start").data, trusted: true }),
  );
  assert.throws(
    () =>
      f.ingress.event(
        {
          ...f.event(
            "receipt",
            { receipt: r },
            { kind: "verifier", id: r.producer.id },
          ).data,
        },
        { kind: "host", id: r.producer.id },
        f.obsData,
      ),
    /producer ingress/,
  );
});
test("A08 CORE inherited array methods and Proxy traps are rejected without executing input code", () => {
  let invoked = 0;
  class EvilArray extends Array {
    map() {
      invoked++;
      return [];
    }
  }
  const array = new EvilArray(1, 2);
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        invoked++;
        return [];
      },
    },
  );
  assert.throws(() => goalJson(array), /prototype/);
  assert.throws(() => goalJson(proxy), /non-data/);
  assert.throws(() => goalInput(array), /prototype/);
  assert.throws(() => goalInput(proxy), /non-data/);
  assert.equal(invoked, 0);
});

test("strict Goal object input produces a fresh clone and revalidates later mutations", () => {
  const shared = { value: 1 };
  const input = Object.assign(Object.create(null), JSON.parse('{"__proto__":{"marker":true}}'), {
    items: [shared, shared],
  });
  const parsed = goalInput(input);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.deepEqual(parsed.__proto__, { marker: true });
  assert.notEqual(parsed.items[0], shared);
  assert.notEqual(parsed.items[0], parsed.items[1]);
  shared.value = 2;
  assert.equal(parsed.items[0].value, 1);
  assert.equal(goalInput(input).items[0].value, 2);
  shared.value = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => goalInput(input), /non-data/);
  assert.throws(() => goalInput('{"value":1,"value":2}'), /duplicate/i);
});

test("strict Goal text retains its canonical serialization with a deeply immutable fresh value", () => {
  const input =
    '{"z":0,"\\u0061":{"__proto__":{"label":"한글🙂"},"escaped\\u004bey":"value"},"items":[1,true,null]}';
  const parsed = parseGoalJsonTextWithCanonical(input);
  const reparsed = parseGoalJsonTextWithCanonical(input);
  assert.equal(parsed.canonicalText, goalJson(parsed.value));
  assert.equal(
    parsed.canonicalText,
    '{"a":{"__proto__":{"label":"한글🙂"},"escapedKey":"value"},"items":[1,true,null],"z":0}',
  );
  assert.notEqual(parsed.value, reparsed.value);
  assert.notEqual(parsed.value.a, reparsed.value.a);
  assert.equal(Object.hasOwn(parsed.value.a, "__proto__"), true);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.value), true);
  assert.equal(Object.isFrozen(parsed.value.a), true);
  assert.equal(Object.isFrozen(parsed.value.a.__proto__), true);
  assert.equal(Object.isFrozen(parsed.value.items), true);
  assert.throws(() => {
    parsed.value.a.__proto__.label = "changed";
  }, TypeError);
  assert.throws(() => {
    parsed.canonicalText = "{}";
  }, TypeError);

  for (const invalid of [
    '{"value":1.5}',
    '{"value":-0}',
    '{"value":1,"\\u0076alue":2}',
    '{"value":',
    `{"value":"${"x".repeat(256 * 1024)}"}`,
    `${"[".repeat(26)}0${"]".repeat(26)}`,
  ])
    assert.throws(() => parseGoalJsonTextWithCanonical(invalid));
  assert.throws(
    () => parseGoalJsonTextWithCanonical({ value: 1 }),
    /text required/,
  );
});

test("canonical Goal descriptor traversal preserves literal keys and rejects extended arrays before their values", () => {
  const value = Object.assign(Object.create(null),
    JSON.parse('{"__proto__":{"value":1},"2":"second","10":"tenth"}'),
    { items: [null, { text: "원문🙂" }, true] });
  assert.equal(goalJson(value),
    '{"10":"tenth","2":"second","__proto__":{"value":1},"items":[null,{"text":"원문🙂"},true]}');
  const extended = ["x".repeat(16385)];
  extended["4294967295"] = "not an array index";
  assert.throws(() => goalJson(extended), /sparse\/extended array/,
    "array shape is rejected before visiting its otherwise over-limit value");
  let invoked = 0;
  const getter = [null];
  Object.defineProperty(getter, "0", { get() { invoked++; return null; } });
  assert.throws(() => goalJson(getter), /accessor\/hidden field/);
  const symbolic = [];
  symbolic[Symbol("hidden")] = true;
  assert.throws(() => goalJson(symbolic), /symbol/);
  assert.equal(invoked, 0);
});

test("S1 root Goal workflow definitions are JSON-only, exclusive, and default finite nesting", () => {
  const spec = {
    schemaVersion: 1,
    executionProfiles: { focused: { "goal.$verifier": { model: "model/v1" } } },
    defaultExecutionProfile: "focused",
    goal: {
      objective: "Prove the selected result.",
      criteria: [
        {
          id: "exact-result",
          verifier: {
            kind: "deterministic",
            producerId: "json-exact-value-v1",
            target: "candidate",
            subject: { resultSlot: "result", artifact: "control" },
            config: {
              comparison: "canonical-json-equality",
              expected: { answer: 42 },
            },
          },
        },
        {
          id: "review",
          verifier: {
            kind: "model-rubric",
            producerId: "reviewer",
            target: "origin",
            subject: { resultSlot: "result", artifact: "analysis" },
            config: { rubric: { minimum: "complete" } },
          },
        },
      ],
      authority: {
        allowedPaths: ["src"],
        protectedPaths: [".git"],
        allowedEffects: ["read", "verify"],
      },
    },
  };
  const parsed = parseWorkflow(spec);
  assert.equal(parsed.goal.nesting.maxDepth, 3);
	const selected = structuredClone(spec);
	selected.goal.criteria[0].verifier.subject.path = "$.result";
	selected.goal.criteria[0].verifier.config.expected = { tools: ["literal"], provider: "data", ratio: 0.25 };
	assert.deepEqual(parseWorkflow(selected).goal.criteria[0].verifier.config.expected, selected.goal.criteria[0].verifier.config.expected);
	for (const path of ["$.items[*]", "$.items[0:2]", "$.constructor", "$.result.__proto__"]) {
		const unsafe = structuredClone(selected);
		unsafe.goal.criteria[0].verifier.subject.path = path;
		assert.throws(() => parseWorkflow(unsafe));
	}
  assert.deepEqual(parsed.goal.criteria[1].verifier.config, {
    rubric: { minimum: "complete" },
  });
  assert.throws(() =>
    parseWorkflow({ ...spec, artifactGraph: { stages: [] } }),
  );
  assert.throws(() =>
    parseWorkflow({
      ...spec,
      goal: {
        ...spec.goal,
        criteria: [
          {
            ...spec.goal.criteria[0],
            verifier: {
              ...spec.goal.criteria[0].verifier,
              config: { comparison: "canonical-json-equality" },
            },
          },
        ],
      },
    }),
  );
  assert.throws(() =>
    parseWorkflow({ ...spec, provider: { agent: "unsafe" } }),
  );
  assert.equal(
    parseWorkflow({
      ...spec,
      goal: {
        ...spec.goal,
        nesting: { maxDepth: 1 },
        criteria: [
          {
            ...spec.goal.criteria[0],
            verifier: {
              ...spec.goal.criteria[0].verifier,
              config: {
                comparison: "canonical-json-equality",
                expected: 1.25,
              },
            },
          },
        ],
      },
    }).goal.criteria[0].verifier.config.expected,
    1.25,
  );
  assert.throws(() =>
    parseWorkflow({
      ...spec,
      goal: { ...spec.goal, nesting: { maxDepth: 0 } },
    }),
  );
  assert.throws(() =>
    parseWorkflow({
      ...spec,
      goal: {
        ...spec.goal,
        authority: { ...spec.goal.authority, allowedPaths: ["../src"] },
      },
    }),
  );
  assert.throws(() =>
    parseWorkflow({
      ...spec,
      goal: {
        ...spec.goal,
        criteria: [{
          ...spec.goal.criteria[1],
          verifier: {
            ...spec.goal.criteria[1].verifier,
            config: { rubric: { prompt: "execute this" } },
          },
        }],
      },
    }),
  );
  assert.throws(() =>
    parseWorkflow({
      ...spec,
      goal: {
        ...spec.goal,
        criteria: [{
          ...spec.goal.criteria[1],
          verifier: {
            kind: "human",
            producerId: "owner",
            target: "artifact",
            subject: { resultSlot: "result", artifact: "control" },
            config: "approve",
          },
        }],
      },
    }),
  );
});

test("S1 Goal parser rejects non-data JSON without invoking getters", () => {
  let getterCalls = 0;
  const valid = {
    schemaVersion: 1,
    goal: {
      objective: "Check.",
      criteria: [{
        id: "exact",
        verifier: {
          kind: "deterministic",
          producerId: "json-exact-value-v1",
          target: "artifact",
          subject: { resultSlot: "result", artifact: "control" },
          config: { comparison: "canonical-json-equality", expected: null },
        },
      }],
      authority: { allowedPaths: ["src"], protectedPaths: ["test"], allowedEffects: ["read"] },
    },
  };
  const getter = { ...valid };
  Object.defineProperty(getter, "goal", {
    enumerable: true,
    get() {
      getterCalls++;
      return valid.goal;
    },
  });
  const cycle = { ...valid };
  cycle.goal.criteria[0].verifier.config.expected = cycle;
  const symbol = { ...valid, [Symbol("unsafe")]: true };
  const sparse = { ...valid, input: [, "x"] };
  for (const invalid of [getter, cycle, symbol, sparse]) {
    assert.throws(() => parseWorkflow(invalid));
  }
  assert.equal(getterCalls, 0);
});

test("S1 embedded goal stages permit graph wiring but no provider controls", () => {
  const workflow = {
    schemaVersion: 1,
    artifactGraph: {
      stages: [
        {
          id: "review",
          type: "goal",
          goal: { uses: "./goal.json" },
          output: { analysis: {} },
        },
      ],
    },
    executionProfiles: { review: { "review.$judge": { thinking: "high" } } },
  };
  assert.doesNotThrow(() => parseArtifactGraphWorkflowSpec(workflow));
  assert.throws(() =>
    parseArtifactGraphWorkflowSpec({
      ...workflow,
      artifactGraph: {
        stages: [{ ...workflow.artifactGraph.stages[0], prompt: "unsafe" }],
      },
    }),
  );
});
