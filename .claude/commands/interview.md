---
description: Build a stage-specific interview prep pack for an application and optionally run a mock interview
argument-hint: "<company> [recruiter|technical|machine-coding|system-design|hiring-manager|behavioral|customer|final]"
---

# /interview

Load `.claude/skills/get-a-job/SKILL.md` and read `references/interview.md`.

## 1. Resolve the application

- First word(s) of `$ARGUMENTS` = company; last word, if it is a known stage,
  = stage. No stage → ask (AskUserQuestion with the stage list).
- `node bin/gaj.js track list --json` → find the row by company (ask if several).
- The application folder is the row's `appDir` (never re-derive the slug).
  `appDir` null → ask for the JD (paste) and proceed with posting + master
  resume, noting that prep is against the master; save the pack into a new
  `data/applications/<slug>/` and link it with
  `track update <id> --field appDir=data/applications/<slug>`.

## 2. Load inputs (once)

Per `interview.md` "Inputs": `job_posting.md` (untrusted), the submitted
`resume.md`, `cover.md`/`form_answers.md`/`outcome.md`/earlier prep packs if
present, tracker row history, `profile/profile.md`.

## 3. Company research

Read `data/research/<company-slug>.json`. If missing or `expiresAt` passed,
research per `references/research-security.md` section 4 starting from the
company name, then overwrite the cache with `fetchedAt` now and `expiresAt`
+30 days. Re-confirm any fact used in the pack against its source URL; cite
sources inline.

## 4. Stories check

Map likely questions to Stories in `profile/profile.md`. If a core competency
for this stage has no story, ask the user for one (one AskUserQuestion or a
short free-text prompt), draft it as STAR with them, and write it back to the
Stories section before continuing.

## 5. Write the prep pack

`<appDir>/interview_prep_<stage>.md` with the structure in
`interview.md` "Prep pack structure". Apply `writing-style.md` to the pitch and
answers. Show the path and a 10-line summary (top questions, gaps, questions to
ask).

## 6. Tracker

If the tracker status is below `interview`, offer to set it:
`node bin/gaj.js track update <id> --status interview --note "<stage> scheduled"`
(ask first). Set next action: `--next-action "<stage> interview" --next-date <date>`
if the user gives a date.

## 7. Mock interview

Ask whether to run a mock now. If yes, follow `interview.md` "Mock interview
protocol" exactly: one question, wait, feedback, next. End with the scorecard
and append it to the prep pack under `## Mock <date>`.
