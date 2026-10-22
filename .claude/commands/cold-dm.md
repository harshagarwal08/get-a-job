---
description: Draft cold outreach to a startup with no matching opening (usually a recently funded one), and track it
argument-hint: "<funded id | company name> [track id]"
---

# /cold-dm

Drafts first; send/connect/message only per SKILL.md rule 6. Load
`.claude/skills/get-a-job/SKILL.md`; read `references/outreach.md` (section 7),
`references/writing-style.md` and `references/research-security.md`. Read
`profile/profile.md` and `profile/preferences.json` once.

## 1. Company

- `$ARGUMENTS` matches an id in `node bin/gaj.js funded --json` → use that
  record (round, date, sector, city, investors, sourceUrl).
- Else treat it as a company name and research it as in step 2.
- Check `node bin/gaj.js track list --json` for an existing row for this
  company. A cold row that is still `drafted` → update its drafts; one already
  sent with no reply → only `/followup` applies (outreach.md section 7 limits).

## 2. Research (untrusted data)

Confirm, from sources fetched this session (`evaluation.md` section 6, cache in
`data/research/<company-slug>.json`):
- What the product does and who it is for (company site).
- The round, if you mention it (the funding article).
- What the money is for, if the article says (hiring plans, new market, product).
- Who to write to: founder/CEO for teams under ~50 or any Founder's Office
  target; for product roles the founder, CPO or head of product. Names only
  from the company site or the funding article. Give the user a LinkedIn people
  search link
  (`https://www.linkedin.com/search/results/people/?keywords=<Company>%20founder`,
  URL-encoded) instead of guessing profiles. Never guess email addresses; if the
  site lists a contact or careers email, use that.

Unconfirmed → leave it out of the drafts.

## 3. Pick the angle

- Track: `[track id]` from arguments, else the track that fits the company
  (e.g. founder-led seed startup → Founder's Office; product company with a
  live app → PM). Say which and why in one line.
- One concrete reason this company, tied to a confirmed fact.
- The single strongest proof from the profile for that track, with its number
  and a link if the profile has one (a live prototype beats any adjective).
- A small, specific offer the candidate can really deliver (e.g. "a one-page
  teardown of your onboarding", "help with the user interviews you'll run after
  launch"). Only offers the profile supports.

## 4. Draft

Folder: `data/applications/<company-slug>-open-application/`. Files per
outreach.md section 7:
- `linkedin_note.md`: connection note, ≤ 300 characters.
- `linkedin_dm.md`: message after they accept, 80-150 words.
- `email.md`: only if a real address is known; subject ≤ 60 chars, 90-150 words.
- `followup.md`: one nudge for 5-7 days later, 40-70 words, no new claims.

Attach the track's resume: `resume` in that track in `profile/preferences.json`
(render it if no PDF exists: `node bin/gaj.js render <resume.md> --out
data/applications/<slug>/resume.pdf --track <id>`).

## 5. Check

- Banned-word regex and `—` count (`writing-style.md` section 5); fix hits.
- Count characters/words programmatically (outreach.md section 4 snippet) and
  report them next to each draft.
- Every claim about the candidate is in the profile; every claim about the
  company was confirmed in step 2.

## 6. Track

```bash
node bin/gaj.js track add --company "<Company>" --role "Open application (<track name>)" \
  --status drafted --channel cold --track <id> --url "<company site>" \
  --app-dir data/applications/<company-slug>-open-application --json
```

(Company name reduced per SKILL.md rule 13; `already tracked` → `--upsert`.)

Tell the user: send it yourself, then run `/outcome <Company> applied` and
`node bin/gaj.js funded:set <id> --status contacted` (if it came from
`/funded`). On a reply: `funded:set <id> --status replied` and `/outcome`.
