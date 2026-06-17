#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
git apply --check .pi/eval/bug-forge/tasks/review-case-c3/fixture.diff
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-c3 >/tmp/bug-forge-review-case-c3-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-c3.json
