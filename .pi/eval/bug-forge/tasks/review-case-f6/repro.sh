#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-f6 >/tmp/bug-forge-review-case-f6-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-review-case-f6.json
