#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

workdir="${TMPDIR:-/tmp}/bug-forge-review-case-aa27-repro-$$"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-aa27 --out "$workdir" >/tmp/bug-forge-review-case-aa27-materialize.json

if ! grep -Fq -- 'const requiredReads = [...(compiledTask.artifactGraph?.requiredReads ?? [])];' "$workdir/src/engine.ts"; then
  echo "RED failed: benign fixture does not contain expected changed text" >&2
  exit 1
fi

git -C "$workdir" apply "$(pwd)/.pi/eval/bug-forge/tasks/review-case-aa27/reference-fix.patch"

if ! grep -Fq -- 'const requiredReads = compiledTask.artifactGraph?.requiredReads ?? [];' "$workdir/src/engine.ts"; then
  echo "GREEN failed: reference fix did not restore expected text" >&2
  exit 1
fi
if grep -Fq -- 'const requiredReads = [...(compiledTask.artifactGraph?.requiredReads ?? [])];' "$workdir/src/engine.ts"; then
  echo "GREEN failed: changed text remains after reference fix" >&2
  exit 1
fi

echo "review-case-aa27 repro passed: benign fixture materializes and reference patch reverts it"
