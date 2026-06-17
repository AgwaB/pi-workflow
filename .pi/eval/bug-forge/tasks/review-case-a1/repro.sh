#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git apply --check .pi/eval/bug-forge/tasks/review-case-a1/fixture.diff
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-a1 >/tmp/bug-forge-review-case-a1-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-a1.json
