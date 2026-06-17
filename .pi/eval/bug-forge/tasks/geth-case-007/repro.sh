#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

workdir="${TMPDIR:-/tmp}/bug-forge-geth-case-007-repro-$$"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

node .pi/eval/bug-forge/scripts/materialize.mjs --task geth-case-007 --out "$workdir" >/tmp/bug-forge-geth-case-007-materialize.json

python3 - "$workdir" <<'PY_RED'
import subprocess, sys
from pathlib import Path
workdir = Path(sys.argv[1])
cmd = ["go", "test", "./core/state/snapshot", "-run", "TestGenerateGoroutineLeak", "-count=1"]
expect = {"contains": "found unexpected goroutines"}
try:
    red = subprocess.run(cmd, cwd=workdir, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    out = red.stdout
    status = red.returncode
except subprocess.TimeoutExpired as exc:
    out = exc.stdout if isinstance(exc.stdout, str) else (exc.stdout.decode(errors='replace') if exc.stdout else '')
    out += "\n[TIMEOUT after 120s]"
    status = 'timeout'
Path('/tmp/bug-forge-geth-case-007-red.log').write_text(out)
if expect.get('status') == 'timeout':
    if status != 'timeout' and '[TIMEOUT' not in out and 'panic: test timed out' not in out:
        print("RED failed: expected timeout-like failure, got status={}\n{}".format(status, out), file=sys.stderr)
        sys.exit(1)
elif status == 0:
    print("RED failed: buggy fixture unexpectedly passed\n{}".format(out), file=sys.stderr)
    sys.exit(1)
needle = expect.get('contains')
if needle and needle not in out:
    print("RED failed: expected output containing {!r}\n{}".format(needle, out), file=sys.stderr)
    sys.exit(1)
PY_RED

git -C "$workdir" apply "$(pwd)/.pi/eval/bug-forge/tasks/geth-case-007/reference-fix.patch"

python3 - "$workdir" <<'PY_GREEN'
import subprocess, sys
from pathlib import Path
workdir = Path(sys.argv[1])
cmd = ["go", "test", "./core/state/snapshot", "-run", "TestGenerateGoroutineLeak", "-count=1"]
green = subprocess.run(cmd, cwd=workdir, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
Path('/tmp/bug-forge-geth-case-007-green.log').write_text(green.stdout)
if green.returncode != 0:
    print("GREEN failed: reference fix did not pass\n{}".format(green.stdout), file=sys.stderr)
    sys.exit(green.returncode or 1)
PY_GREEN

echo "geth-case-007 repro passed: buggy fixture fails and reference fix passes"
