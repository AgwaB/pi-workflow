#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$root/test/e2e/fixtures/worktree-base"
not_a_directory="$root/test/e2e/fixtures/not-a-directory"

mkdir -p "$fixture"
mkdir -p "$(dirname "$not_a_directory")"
if [ ! -f "$fixture/README.md" ]; then
	cat >"$fixture/README.md" <<'MD'
# Worktree Fixture

Small git repository used by pi-workflow E2E scenarios that require a managed worktree.
MD
fi

if [ ! -d "$fixture/.git" ]; then
	git -C "$fixture" init >/dev/null
	git -C "$fixture" config user.email pi-workflow-e2e@example.invalid
	git -C "$fixture" config user.name 'Pi Workflow E2E'
	git -C "$fixture" add README.md
	git -C "$fixture" commit -m 'Initial worktree fixture' >/dev/null
fi

if [ ! -e "$not_a_directory" ]; then
	printf 'This file intentionally is not a directory.\n' >"$not_a_directory"
fi

echo "Prepared git worktree fixture: $fixture"
echo "Prepared invalid cwd fixture: $not_a_directory"
