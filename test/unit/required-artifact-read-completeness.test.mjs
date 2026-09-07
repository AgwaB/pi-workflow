import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRequiredArtifactReads } from "../../.tmp/unit/subagent-backend.js";
import { artifactReadFixture as fixture } from "./helpers/workflow-artifact-fixture.mjs";

for (const limits of [{ maxItems: 1, maxChars: 1000 }, { maxItems: 2, maxChars: 2 }]) {
 test(`real truncated projection cannot satisfy required reads ${JSON.stringify(limits)}`, async (t) => {
  const f = await fixture(t);
  const result = await f.read({ path: "$.items", ...limits });
  assert.equal(result.details.truncated, true);
  const requirement = { source: "producer", artifact: "control", path: "$.items", ...limits, count: 1 };
  assert.equal((await checkRequiredArtifactReads(f.consumer, ["producer.control"])).missing.length, 1);
  assert.equal((await checkRequiredArtifactReads(f.consumer, [requirement])).missing.length, 1);
  assert.equal((await checkRequiredArtifactReads(f.consumer, [], [{ ...requirement, mustNotTruncate: false }])).projectionFailures.length, 1);
 });
}

test("required reads preserve missing, wrong-path, empty-slice, exact-count and valid controls", async (t) => {
 const f = await fixture(t);
 const req = { source: "producer", artifact: "control", path: "$.items", maxItems: 2, maxChars: 1000, count: 1 };
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 await f.read({ path: "$.empty", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ ...req, path: "$.empty" }])).missing.length, 0);
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.deepEqual(await checkRequiredArtifactReads(f.consumer, [req, "producer.control"]), { missing: [], projectionFailures: [] });
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [req])).missing.length, 1);
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ ...req, count: 2 }])).missing.length, 0);
});

test("truncated rows do not inflate the exact count of qualifying reads", async (t) => {
 const f = await fixture(t);
 await f.read({ path: "$.items", maxItems: 1, maxChars: 1000 });
 await f.read({ path: "$.items", maxItems: 2, maxChars: 1000 });
 assert.equal((await checkRequiredArtifactReads(f.consumer, [{ source: "producer", artifact: "control", count: 1 }])).missing.length, 0);
});
