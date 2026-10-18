# Resume rules

## 1. Format

`resume.md` follows the format in `docs/CONTRACTS.md` → "`resume.md` format"
(see `examples/resume.example.md`). Key points:

- `#` name; first paragraph = contact line, items separated by ` · `.
- `##` sections; `### Title | Org` entries; optional next line `Dates | Location`.
- Bullets start with `- `. Optional trailing `<!-- tracks: fe,fde -->` keeps the
  bullet only when rendering with a matching `--track`. Untagged bullets always render.
- Date ranges: `Mon YYYY - Mon YYYY` or `Mon YYYY - Present`, ASCII hyphen with
  spaces. Never `–`, `—`, or `--`.
- Standard section headings only: Summary, Experience, Projects, Skills,
  Education, Certifications (optionally Publications, Awards). No creative names.

## 2. Master vs tailored

- **Master**: `profile/resume.md`. Complete, faithful to the candidate's real
  history, may exceed one page, carries track tags. Edited only by /onboard or
  when the user asks, never as a side effect of tailoring.
- **Tailored**: `data/applications/<slug>/resume.md`. A copy of the master cut
  and reordered for one posting. Never a source of facts for later sessions;
  may be read for phrasing only.
- **Track tags**: tag a bullet when it only makes sense for some tracks (e.g. a
  customer-facing integration bullet → `fde`; a design-system bullet → `fe`).
  Render tailored copies with `--track <id>` of the job's track so tagged bullets
  for other tracks drop out. In the tailored copy you may also delete bullets
  outright.

## 3. Tailoring algorithm

1. **Requirement list.** Extract every requirement from the posting: required
   skills, preferred skills, years, domain, responsibilities, logistics. Keep
   the posting's exact wording for each.
2. **Requirement → evidence map.** For each requirement, find evidence in the
   sources (section 4). Mark `matched (where)`, `adjacent (what)`, or `gap`.
   This map is reused for the keyword table and the cover note.
3. **Summary.** Rewrite 2-4 plain sentences: current role + years, the one or
   two strongest matched requirements with a real number, what they want next
   framed toward this role. No adjectives about personality.
4. **Reorder.** Within each role, put bullets matching the top requirements
   first. Reorder Skills so the posting's required stack leads. Move Projects
   above Experience only for early-career candidates whose projects are the
   strongest evidence.
5. **Mirror vocabulary only where true.** If the candidate did the thing under
   another name, use the posting's term ("end-to-end testing" → "Cypress" only if
   they used Cypress). Never import a term for work they did not do.
6. **Cut by relevance, do not pad.** Score each line on (a) relevance to this
   posting, (b) uniqueness (not repeated elsewhere), (c) recency. Remove the
   lowest first, whatever section it is in. An older bullet that hits a core
   requirement beats a recent irrelevant one. Never add filler bullets to fill
   space.
7. **Length.** 1 page by default (India market, startups, < 8 years
   experience). 2 pages maximum, only for 8+ years and only when page 2 holds
   relevant material. Enforce with `verify --pages`.
8. **Bullet shape.** Verb + what + how/stack + result with a number when the
   source has one. One line ideally, two at most.

## 4. Grounding audit

Sources (a claim is grounded if ANY one supports it):
1. `profile/profile.md`
2. `profile/resume.md` (master)
3. Facts the user confirmed this session **and that were written back** to
   `profile/profile.md` (write-back rule).

Procedure, after tailoring and reviewer edits, before render:
- Walk every line of the tailored resume. Check employer, title, dates,
  location, numbers, team sizes, tools, scope words (led/owned/built/helped).
- List each claim that is not traceable. For each: remove it, revert to the
  source wording, or ask the user. If the user confirms, write back first, then
  keep it.
- If the sources disagree with each other (e.g. different dates), stop and ask
  the user which is right, then fix the wrong source.
- Rephrasing emphasis is fine. Changed facts or escalated numbers are not.

## 5. Interview backtrack test

For each tailored bullet ask: could the candidate explain this in an interview
without saying "well, what I actually meant was..."?

| Class | Examples | Action |
|---|---|---|
| OK | Reordered for relevance; natural synonym; emphasising one true aspect of a broad role | keep |
| Flag | Posting's exact term for adjacent-but-not-same work; blending side-project and job experience into one claim; scope word one notch up ("owned" for "co-owned") | ask the user |
| Never | Experience they do not have; a domain they did not work in; invented metrics | remove |

Present flagged bullets after drafting, one line each:
`Stretch: "<bullet>" (because <reason>). Keep, soften, or drop?`
Apply the answer. If they supply a new fact, write it back.

## 6. ATS rules

- Single column; the templates already do this. Do not add tables or text boxes.
- Contact details as literal text: email and phone printed in full. Link text
  shows the URL (`linkedin.com/in/x`), not just "LinkedIn".
- ASCII date ranges with both start and end on every role and degree.
- Standard headings (section 1).
- `verify` must report extractable text, no ASCII-date failures, and pages ≤ limit.

### Keyword table (goes into `ats_report.md`)

Build from the requirement list (required + preferred, the posting's exact
terms). Pass the list to `verify --keywords` and combine its coverage output
with the evidence map:

| Keyword | Priority | Status | Note |
|---|---|---|---|
| React | required | covered | Experience, Acme bullet 1 |
| Cypress | preferred | variant | resume says "Playwright"; posting term not true, leave |
| Jest | required | missing-but-true | profile Skills lists Jest; add to Skills / a bullet |
| GraphQL | preferred | genuine gap | no evidence; mention honestly in cover if relevant |

- **covered**: term appears (case/inflection-insensitive).
- **variant**: concept present under another term. Switch to the posting's term
  only if it is literally true.
- **missing-but-true**: profile shows the candidate has it; add it where it fits
  (a bullet beats the Skills list), re-render, re-verify.
- **genuine gap**: leave it out. **Never stuff a gap.** It belongs in the fit
  evaluation and, if useful, an honest line in a cover note.
