#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

workdir="${TMPDIR:-/tmp}/bug-forge-review-case-j10-repro-$$"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-j10 --out "$workdir" >/tmp/bug-forge-review-case-j10-materialize.json

if grep -q '"scrapling_fetch"' "$workdir/src/compiler.ts"; then
  echo "RED failed: buggy fixture still contains scrapling_fetch in READ_ONLY_TOOLS" >&2
  exit 1
fi

git -C "$workdir" apply "$(pwd)/.pi/eval/bug-forge/tasks/review-case-j10/reference-fix.patch"

if ! grep -q '"scrapling_fetch"' "$workdir/src/compiler.ts"; then
  echo "GREEN failed: reference fix did not restore scrapling_fetch" >&2
  exit 1
fi

echo "review-case-j10 repro passed: fixture removes scrapling_fetch; reference fix restores it"
