#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
workspace="$(mktemp -d -t bug-forge-d4-repro-XXXXXX)"
cleanup() { rm -rf "$workspace"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-d4 --out "$workspace" >/tmp/bug-forge-review-case-d4-materialize.json

# Buggy fixture should reproduce the localization loss: file survives but line is absent.
WORKSPACE="$workspace" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: helper } = await import(pathToFileURL(`${process.env.WORKSPACE}/workflows/deep-review/helpers/finding-pipeline.mjs`));
const result = await helper({
  sources: {
    reviewer: {
      findings: [{
        severity: 'medium',
        title: 'colon citation',
        file: 'src/compiler.ts',
        evidence: 'src/compiler.ts:801 shows the runtime task condition',
      }],
    },
  },
  options: { mode: 'dedup' },
});
assert.equal(result.findings[0].locations[0].file, 'src/compiler.ts');
assert.equal(result.findings[0].locations[0].line, undefined, 'bug should drop colon line reference');
NODE

# Reference fix should restore line extraction from the same evidence.
(cd "$workspace" && git apply "$OLDPWD/.pi/eval/bug-forge/tasks/review-case-d4/reference-fix.patch")
WORKSPACE="$workspace" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: helper } = await import(pathToFileURL(`${process.env.WORKSPACE}/workflows/deep-review/helpers/finding-pipeline.mjs`));
const result = await helper({
  sources: {
    reviewer: {
      findings: [{
        severity: 'medium',
        title: 'colon citation',
        file: 'src/compiler.ts',
        evidence: 'src/compiler.ts:801 shows the runtime task condition',
      }],
    },
  },
  options: { mode: 'dedup' },
});
assert.equal(result.findings[0].locations[0].file, 'src/compiler.ts');
assert.equal(result.findings[0].locations[0].line, 801, 'reference fix should restore colon line extraction');
NODE

node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-d4.json
