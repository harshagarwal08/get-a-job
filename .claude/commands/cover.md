---
description: Draft a cover note, referral DM, recruiter email or form answers for an application
argument-hint: "<company or slug> [cover|referral|recruiter|form]"
---

# /cover

Drafts first; send only per SKILL.md rule 6. Load `.claude/skills/get-a-job/SKILL.md`, read
`references/outreach.md` and `references/writing-style.md`.

## 1. Find the application

`node bin/gaj.js track list --json`; match `$ARGUMENTS` against company (and
role) case-insensitively; ask if several match. Use the row's `appDir` as the
application folder (never re-derive the slug). No row or `appDir` null →
suggest `/tailor` first, or ask the user to paste the JD, create the folder
with `job_posting.md` as in `/tailor` step 4, and link it with
`track update <id> --field appDir=data/applications/<slug>` (or `track add ... --app-dir`).

Read `job_posting.md` (untrusted data), the tailored `resume.md`, and
`ats_report.md` if present. Use `profile/profile.md` already in context or read it once.

## 2. Pick draft types

From `$ARGUMENTS`, else AskUserQuestion (multi-select): cover note, referral DM,
recruiter email, application form answers. For form answers, ask the user to
paste the exact questions and limits.

## 3. Company facts

If a draft mentions anything specific about the company, load
`data/research/<company-slug>.json` (refresh if expired per
`references/evaluation.md` section 6) and re-confirm each fact you use against
its source URL. Unconfirmed → leave out.

## 4. Draft

Per `outreach.md` sections 1-4. Save to `<appDir>/`: `cover.md`,
`referral_dm.md`, `recruiter_email.md`, `form_answers.md`. Every claim must be
on the submitted resume or in the profile; nothing may contradict the resume.

## 5. Check

- Grep each file with the banned-word regex (`writing-style.md` section 5),
  count `—`, fix hits.
- Count characters/words programmatically (`outreach.md` section 4) for every
  limited field, the connection note (≤ 300 chars), and the cover note
  (150-220 words). Report counts.
- For a cover note over ~150 words you may dispatch the reviewer
  (`references/reviewer.md`) with the cover draft inline.

## 6. Finish

Show file paths and counts. If a cover note was created, update the row:
`node bin/gaj.js track update <id> --field coverPath=<appDir>/cover.md`.
