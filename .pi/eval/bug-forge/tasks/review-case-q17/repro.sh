#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

workdir="${TMPDIR:-/tmp}/bug-forge-review-case-q17-repro-$$"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-q17 --out "$workdir" >/tmp/bug-forge-review-case-q17-materialize.json

if ! grep -Fq -- 'spec.defaults?.thinking ?? options.runtimeDefaults?.thinking' "$workdir/src/compiler.ts"; then
  echo "RED failed: buggy fixture does not contain expected changed text" >&2
  exit 1
fi

git -C "$workdir" apply "$(pwd)/.pi/eval/bug-forge/tasks/review-case-q17/reference-fix.patch"

if ! grep -Fq -- 'options.runtimeDefaults?.thinking ?? spec.defaults?.thinking' "$workdir/src/compiler.ts"; then
  echo "GREEN failed: reference fix did not restore expected text" >&2
  exit 1
fi
if grep -Fq -- 'spec.defaults?.thinking ?? options.runtimeDefaults?.thinking' "$workdir/src/compiler.ts"; then
  echo "GREEN failed: changed text remains after reference fix" >&2
  exit 1
fi

echo "review-case-q17 repro passed: buggy fixture materializes and reference patch reverts it"
