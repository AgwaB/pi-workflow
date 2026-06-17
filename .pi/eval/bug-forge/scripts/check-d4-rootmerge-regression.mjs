#!/usr/bin/env node
import { readJson, scoreFindings, extractFindingsJson, validateCandidateFindings } from './lib/findings.mjs';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const BF = path.join(ROOT, '.pi/eval/bug-forge');
const gold = readJson(path.join(BF, 'tasks/review-case-d4/gold-key.draft.json'));

const cases = [
  {
    label: 'ab-old',
    output: 'runs/ab-rootmerge-20260615T201703Z/02-ab-old-workflow/review-case-d4/workflow/output.md',
    expected: { recall: 1, fp: 1 },
  },
  {
    label: 'ab-current',
    output: 'runs/ab-rootmerge-20260615T201703Z/03-ab-current-workflow/review-case-d4/workflow/output.md',
    expected: { recall: 1, fp: 0 },
  },
  {
    label: 'expanded-old',
    output: 'runs/expanded-ab-rootmerge-20260616T033943Z/01-old-workflow/review-case-d4/workflow/output.md',
    expected: { recall: 1, fp: 1 },
  },
  {
    label: 'expanded-current',
    output: 'runs/expanded-ab-rootmerge-20260616T033943Z/02-current-workflow/review-case-d4/workflow/output.md',
    expected: { recall: 1, fp: 0 },
  },
];

const results = [];
for (const item of cases) {
  const outputPath = path.join(BF, item.output);
  if (!fs.existsSync(outputPath)) throw new Error(`${item.label}: missing ${outputPath}`);
  const extracted = extractFindingsJson(fs.readFileSync(outputPath, 'utf8'));
  const validationIssues = validateCandidateFindings(extracted.data);
  const score = scoreFindings(gold, extracted.data);
  const ok = extracted.ok && !validationIssues.length && score.recall === item.expected.recall && score.falsePositiveCount === item.expected.fp;
  results.push({ label: item.label, ok, extractionMode: extracted.extractionMode, validationIssues, expected: item.expected, actual: { score: score.objectiveScore, recall: score.recall, precision: score.precision, fp: score.falsePositiveCount, missed: score.missed } });
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failed.length === 0, results }, null, 2));
if (failed.length) process.exitCode = 1;
