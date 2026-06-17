#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git apply --check .pi/eval/bug-forge/tasks/review-case-e5/fixture.diff
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-e5 >/tmp/bug-forge-review-case-e5-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-review-case-e5.json
