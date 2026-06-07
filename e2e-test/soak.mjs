#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const resultDir = join(root, "e2e-test", "results", `soak-${stamp}`);
const args = new Set(process.argv.slice(2));
const iterations = numberArg("--iterations", 2);
const runFullE2e = args.has("--full-e2e");
const commands = runFullE2e
  ? [["npm", ["run", "typecheck"]], ["npm", ["test"]], ["npm", ["run", "e2e"]]]
  : [["npm", ["run", "typecheck"]], ["npm", ["test"]]];

mkdirSync(resultDir, { recursive: true });
const rows = [];
let failed = false;

for (let iteration = 1; iteration <= iterations; iteration += 1) {
  for (const [command, commandArgs] of commands) {
    const label = `iter-${iteration}-${[command, ...commandArgs].join("-").replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
    const result = spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
    const status = result.status ?? (result.error ? 1 : 0);
    const evidence = join(resultDir, `${label}.out`);
    writeFileSync(evidence, [
      `$ ${[command, ...commandArgs].join(" ")}`,
      `exitCode=${status}`,
      "",
      "## stdout",
      result.stdout ?? "",
      "",
      "## stderr",
      result.stderr ?? "",
      result.error ? `\n## spawn error\n${result.error.message}` : "",
    ].join("\n"));
    rows.push({ iteration, command: [command, ...commandArgs].join(" "), status, evidence: relative(root, evidence) });
    console.log(`${status === 0 ? "✓" : "✗"} ${label}`);
    if (status !== 0) {
      failed = true;
      break;
    }
  }
  if (failed) break;
}

const report = [
  "# pi-subagent-flow soak report",
  "",
  `Date: ${new Date().toISOString()}`,
  `Result: ${failed ? "FAIL" : "PASS"}`,
  `Iterations requested: ${iterations}`,
  `Full E2E: ${runFullE2e}`,
  `Evidence: ${relative(root, resultDir)}`,
  "",
  "| Iteration | Command | Exit | Evidence |",
  "|---:|---|---:|---|",
  ...rows.map((row) => `| ${row.iteration} | \`${row.command}\` | ${row.status} | ${row.evidence} |`),
  "",
].join("\n");
writeFileSync(join(resultDir, "report.md"), report);
writeFileSync(join(root, "e2e-test", "soak-report.md"), report);
console.log(`Report written to ${relative(root, join(resultDir, "report.md"))}`);
if (failed) process.exitCode = 1;

function numberArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

if (!existsSync(root)) process.exitCode = 1;
