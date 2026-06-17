#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
node .pi/eval/bug-forge/scripts/materialize.mjs --task review-case-i9 >/tmp/bug-forge-review-case-i9-materialize.json
node .pi/eval/bug-forge/scripts/validate.mjs >/tmp/bug-forge-validate-review-case-i9.json
