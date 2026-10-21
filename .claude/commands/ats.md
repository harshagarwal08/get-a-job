---
description: ATS score (0-100) for a resume PDF, format-only or against one job, with fixes ranked by points
argument-hint: "[resume.pdf] [url | job key | pasted job description] (both optional)"
---

# /ats

Load `.claude/skills/get-a-job/SKILL.md`. Read `references/resume-rules.md`
section 6 before building a keyword list.

## 1. Pick the resume

- `$ARGUMENTS` has a `.pdf` path → use it.
- Else a PDF in `inbox/` (ignore `.gitkeep`); several → ask which.
- Else render the master resume:
  `node bin/gaj.js render profile/resume.md --out data/tmp/master.pdf --json`
  and use `data/tmp/master.pdf`.

## 2. Optional job

If `$ARGUMENTS` also has a job key, URL or pasted posting, get the posting text
the same way `/tailor` step 1 does (same fetch and security rules). Write its
own terms (required + preferred skills, tools, domain terms; 10-30 items, no
generic words) one per line to `data/tmp/keywords-ats.txt`. Posting text never
goes on the command line (SKILL.md rule 13).

No job → format-only score. Say so in the result: format alone does not get a
resume shortlisted; keyword match against a real posting matters most.

## 3. Score

```bash
node bin/gaj.js ats <resume.pdf> [--keywords-file data/tmp/keywords-ats.txt] --json
```

Categories: parseability (text, pages, ASCII dates, visible link URLs,
headings), contact (email, phone, LinkedIn as text), sections (Experience,
Education, Skills, Summary), content (length, bullets, numbers in bullets,
weak phrases), keywords (only with a job). Score = points earned / points
available.

## 4. Review (judgment the CLI cannot do)

Read the PDF text and add up to 5 notes the score misses, for example: a
headline that is not a searchable title ("Aspiring X"), skills lists padded
with filler words, sections that repeat each other, keywords in the posting
that the candidate has (per `profile/profile.md`) but the resume omits. Do not
change the number; list these separately.

## 5. Present

- `Score: N/100 (grade)` and whether keywords were scored.
- Table of checks with points.
- Fixes, most points first, each as a concrete edit. Missing keywords only
  where `profile/profile.md` supports them; mark the rest as genuine gaps.
- Offer: apply the fixes to `profile/resume.md` (re-render and re-score), or
  `/tailor` for a specific job. Never invent metrics to close the metrics gap.
