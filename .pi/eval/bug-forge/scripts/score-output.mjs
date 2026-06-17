#!/usr/bin/env node
import fs from "node:fs";
import { extractFindingsJson, readJson, scoreFindings, validateCandidateFindings } from "./lib/findings.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const goldPath = arg("--gold");
const outputPath = arg("--output");
if (!goldPath || !outputPath) {
  console.error("Usage: score-output.mjs --gold <gold-key.json> --output <candidate-output.md>");
  process.exit(2);
}

const gold = readJson(goldPath);
const output = fs.readFileSync(outputPath, "utf8");
const extracted = extractFindingsJson(output);
const validationIssues = validateCandidateFindings(extracted.data);
const score = scoreFindings(gold, extracted.data);
console.log(JSON.stringify({ extracted: { ok: extracted.ok, extractionMode: extracted.extractionMode, error: extracted.error }, validationIssues, score }, null, 2));
if (!extracted.ok || validationIssues.length) process.exitCode = 1;
