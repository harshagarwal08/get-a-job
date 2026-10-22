---
description: Apply to one job in the logged-in browser (Playwright) - tailor the resume, save it locally, fill the form, and submit after you confirm
argument-hint: "<job key | application id | company>"
---

# /apply

One job per run, only when the user asked for this job (SKILL.md rule 6).
Load `.claude/skills/get-a-job/SKILL.md`; read `references/browser.md`
(sections 1-3, 5), `references/outreach.md` and `references/writing-style.md`.

## 1. Find the job and application

- Job key → `node bin/gaj.js job <key> --json`; then
  `node bin/gaj.js track list --json` for a row with that `jobKey`.
- `app_<8 hex>` → that row; its `jobKey` (if any) for the posting.
- Company name → match in `track list`, then `jobs --json`; more than one →
  ask which.
- Row status already `applied` or later → say so and stop unless the user
  says to apply again.
- Eligibility gates (rule 4) failed → stop and say why unless overridden.

## 2. Tailored resume (saved locally)

No `resume.pdf` in the row's `appDir`, or the user asks for a fresh one → run
the full `/tailor` flow for this job (it creates
`data/applications/<slug>/resume.pdf`, `ats_report.md` and the tracker row).
Otherwise reuse the existing PDF and say which one. Show the PDF path.

## 3. Answers ready

Read `<appDir>/form_answers.md` and `cover.md` if present. If the posting asks
for a cover letter or "why us" and none exists, draft it now per
`outreach.md` (saved in `appDir`) and show it.

## 4. Open the apply page

Per `browser.md` section 1, in a new tab, open the job's `applyUrl` (else
`url`) from `jobs.json`. Easy Apply / on-site apply → use it. External → follow
the site's own Apply button to the employer page. Check the destination host:
known ATS or the company's own domain is fine; anything else (a lookalike, a
form asking for payment, ID documents, bank details) → stop and tell the user.
Login/account creation required → hand over: the user logs in or creates the
account, then says "done".

## 5. Fill

Per `browser.md` section 5. Field by field from the profile; ask for anything
missing (save confirmed facts to `profile/profile.md` the same turn). Upload
the PDF from step 2 with `browser_file_upload`. Don't submit yet.

## 6. Confirm and submit

Show: destination URL, attached file, every field label → value, any cover
text. AskUserQuestion: Submit / Edit something / Stop. Only on Submit, click
the final submit button once. Screenshot the confirmation page.

## 7. Record

- Write `<appDir>/applied.md` (date, URL, channel, fields summary).
- `node bin/gaj.js track update <id> --status applied --field channel=<easy-apply|ats|careers> --note "applied via browser <yyyy-mm-dd>" --next-action "follow up" --next-date <today+7>`
- Job key → `node bin/gaj.js jobs:set <key> --status tracked`.
- Close the tab. Suggest `/outreach <id>` (referral or hiring-manager DM)
  and `/send` for a drafted message.
