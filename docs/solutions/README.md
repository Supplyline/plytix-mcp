# Solutions Knowledge Base

Documented solutions to problems we've solved. Search here before researching new issues.

## Categories

- `build-errors/` — Compilation, bundling, deployment failures
- `runtime-errors/` — Errors that occur during execution
- `performance-issues/` — Slow queries, memory leaks, latency
- `integration-issues/` — Third-party API problems (Plytix)
- `api-quirks/` — Non-obvious API behaviors

## File Format

Each solution uses this template:

```markdown
---
module: [component name]
date: YYYY-MM-DD
problem_type: [category]
symptoms:
  - "Exact error message or observable behavior"
root_cause: [brief technical cause]
severity: [critical|high|medium|low]
tags: [searchable, tags]
---

# [Descriptive Title]

## Symptom
What you observe when this problem occurs.

## Root Cause
Why it happens (technical explanation).

## Solution
How to fix it (with code examples if applicable).

## Prevention
How to avoid this in the future.
```

## Searching

Use grep to find solutions:
```bash
grep -r "plytix" docs/solutions/
grep -r "401" docs/solutions/
grep -l "severity: critical" docs/solutions/
```
