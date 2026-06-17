#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-o15 >/tmp/bug-forge-review-case-o15-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-review-case-o15.json
