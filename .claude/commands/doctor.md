---
description: Check the environment and profile completeness, and suggest fixes
---

# /doctor

## 1. Environment

```bash
node bin/gaj.js doctor --validate
```

For each ✗ give the fix: Node < 20 → install Node 20+; puppeteer/Chrome missing
→ `npm install`; profile files missing → `/onboard`; `config/companies.json`
missing → copy `config/companies.example.json` (or `/onboard` step 8).

## 2. Profile completeness

If the profile files exist, read them and check:

| Check | Problem if |
|---|---|
| `profile/preferences.json` | invalid JSON; no tracks; a track with no titles; `compensation.min` is 0; `noticePeriodDays` missing; `location.workAuthorization` empty |
| `profile/profile.md` | template placeholders left (`<...>`, `TODO`, `Jane Doe`, `example.com`); Stories section has < 3 filled stories; metrics still marked `(inferred — confirm)` or `(draft — confirm)`; no Skills proficiency |
| `profile/resume.md` | missing contact line, email or phone; non-ASCII date ranges (`–`, `—`); entries without dates; track tags referencing ids not in preferences |
| Consistency | employers/titles/dates differ between `profile.md` and `resume.md` |
| `config/companies.json` | invalid JSON; `ats` not in `greenhouse\|lever\|ashby\|workable\|smartrecruiters\|recruitee`; `region` values outside `india\|us\|eu\|uk\|apac\|remote-global`; empty list or no company in the user's regions (suggest `/discover`) |
| `preferences.sources` | every board off and few companies → suggest enabling `hn`/`remotive`/`arbeitnow` to match location |

Optionally run `node bin/gaj.js render profile/resume.md` and `verify` on the
result to confirm the resume still renders.

## 3. Report

A ✓/✗ list, then fixes ordered by impact, each with the command or the exact
section to edit. Offer to fix the ones that only need the user's answers (ask
the questions, then write back).
