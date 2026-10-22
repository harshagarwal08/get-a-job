---
description: Open your logged-in Chrome, search LinkedIn, Wellfound, Naukri, Instahyre, Cutshort and careers pages, collect matching jobs with full details, and add the ones you approve
argument-hint: "[sites: linkedin,wellfound,naukri,instahyre,cutshort,careers] [track id] [extra criteria]"
---

# /browse

Load `.claude/skills/get-a-job/SKILL.md`; read `references/browser.md` (all of
it) and `references/research-security.md`. Read `profile/preferences.json` and
`profile/profile.md` once. No preferences → tell the user to run `/onboard`.

## 1. Parse args and plan

- Sites from `$ARGUMENTS` (comma list); default all of `linkedin, wellfound,
  naukri, instahyre, cutshort`. `careers` = JS-only careers pages from
  `config/companies.json` (`ats: "careers"`) only.
- Track id → that track only; else every track in preferences.
- Any other text = extra criteria (e.g. "remote only", "series A+", "past 3
  days"), applied on top of preferences.
- Searches per site: one per track (its first 1-2 `titles`) × the user's
  location / remote scope from preferences. Cap per `browser.md` section 3.
- Tell the user in 2 lines: sites, searches, caps, and that you will pause on
  any login/CAPTCHA screen.

## 2. Check the browser

Per `browser.md` section 1. Open one new tab. For each site, load its entry
page first; if it shows a login wall, ask the user to log in in that tab and
say "done" (or skip the site). Never type credentials.

## 3. Sweep (per site, per search)

1. Open the search, set filters (date ≤ `maxAgeDays` from preferences,
   location/remote, experience) through the site's own UI or URL params.
2. Read the result list (page text, not screenshots, where possible). For each
   card: title, company, location, link. Skip right away when the title hits a
   track's `excludeTitles` or matches no track title/keyword, or the company is
   in `preferences.excludeCompanies` (if present).
3. Already known? Check before opening: `node bin/gaj.js jobs --json` once at
   the start, keep its URLs/keys in context; skip cards whose canonical link
   is already there.
4. Open each remaining card's detail page (same site only), and extract:
   `title, company, url` (the site's own job URL), `location`, `workMode`
   (`remote|hybrid|onsite` only if stated), `salary` (as written), `postedAt`
   (ISO; convert "3 days ago" against today), `description` (full text, as
   shown), and `applyType`: `easy-apply` (on-site) or `external` (+ the
   employer apply URL only if the site's own Apply button reveals it without
   submitting anything).
5. Run the eligibility gates (SKILL.md rule 4) on each; mark gate failures
   `orange` with the reason. Give each a quick fit `high|medium|low` from the
   track keywords and profile (no full ranking yet).
6. Respect pacing; stop the site early at the caps or on any stop condition.

## 4. Verify with the user

Write all candidates to `data/tmp/browse-<site>.json` (array of
`{title, company, url, location?, workMode?, salary?, postedAt?, description?}`;
keep `applyType`, gate notes and quick fit in a separate
`data/tmp/browse-notes.json` keyed by url).

Show one table, best first: # · fit · title · company · location/mode · posted
· site · apply type · gate issue. Orange rows collapsed at the end.
AskUserQuestion (multi-select over groups, then free text for numbers): add
all high, all high+medium, or pick by number. Nothing is imported without this
answer.

## 5. Import

Remove unapproved entries from each `browse-<site>.json`, then per site:

```bash
node bin/gaj.js jobs:import data/tmp/browse-<site>.json --source browser --via <site>
```

(`careers` → `--via other`.) Then set quick fit for the imported keys in one
call: write `data/tmp/browse-quickfit.json` (`{"<key>": "high"}`) and run
`node bin/gaj.js jobs:set --quick-fit-file data/tmp/browse-quickfit.json`.
Report per site: searched, seen, skipped (known / title / gate), imported.

## 6. Next

Suggest `/rank` for the new jobs, `/apply <key>` for a high one, and
`/outreach <key>` for who to contact. Close the tab you opened.
