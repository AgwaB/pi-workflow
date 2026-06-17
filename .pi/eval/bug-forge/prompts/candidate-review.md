# Candidate Review Prompt Template

You are reviewing a proposed local patch to this repository.

The patch may be correct or may contain issues. Review only the provided diff and the sanitized repository workspace. Report only material issues grounded in the diff or repository. If there are no material issues, say so.

You may inspect the sanitized workspace, but do not rely on git history, prior eval notes, answer keys, scoring files, or external/private artifacts. If such files appear to be present, ignore them and report that the workspace is contaminated.

Focus on:
- correctness and regressions
- safety/security/reliability risks
- API/schema/contract mismatches
- test and validation consequences
- evidence quality: cite exact file/line and a short quote

Do not assume a bug exists. Do not invent issues to fill the report.

Return a concise Markdown review followed by one machine-readable JSON block with this minimal shape:

```json
{
  "findings": [
    {
      "severity": "critical|high|medium|low",
      "file": "path/to/file",
      "line": 123,
      "lineEnd": 130,
      "claim": "what is wrong",
      "evidenceQuote": "short exact quote from the diff or source",
      "fix": "brief safe fix direction",
      "confidence": 0.8
    }
  ],
  "noMaterialIssues": false
}
```

If no material issue exists, use:

```json
{
  "findings": [],
  "noMaterialIssues": true
}
```

The JSON block must not include task bucket, expected finding count, gold IDs, scoring details, or A/B arm labels.
