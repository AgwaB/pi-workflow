#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git apply --check .pi/eval/bug-forge/tasks/review-case-b2/fixture.diff
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-b2 >/tmp/bug-forge-review-case-b2-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-b2.json
