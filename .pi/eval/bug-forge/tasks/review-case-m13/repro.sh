#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

workdir="${TMPDIR:-/tmp}/bug-forge-review-case-m13-repro-$$"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-m13 --out "$workdir" >/tmp/bug-forge-review-case-m13-materialize.json

if ! grep -q 'items.length >= stage.maxItems' "$workdir/src/engine.ts"; then
  echo "RED failed: buggy fixture does not contain the >= maxItems guard" >&2
  exit 1
fi
if ! grep -q 'exceeding maxItems=${stage.maxItems}' "$workdir/src/engine.ts"; then
  echo "RED failed: buggy fixture does not contain expected maxItems error text" >&2
  exit 1
fi

git -C "$workdir" apply "$(pwd)/.pi/eval/bug-forge/tasks/review-case-m13/reference-fix.patch"

if ! grep -q 'items.length > stage.maxItems' "$workdir/src/engine.ts"; then
  echo "GREEN failed: reference fix did not restore strict greater-than maxItems guard" >&2
  exit 1
fi
if grep -q 'items.length >= stage.maxItems' "$workdir/src/engine.ts"; then
  echo "GREEN failed: >= maxItems guard remains after reference fix" >&2
  exit 1
fi

echo "review-case-m13 repro passed: fixture introduces >= boundary bug; reference fix restores > guard"
