---
description: Change your job-search preferences (roles, titles, locations, sources) and optionally re-run the search
argument-hint: "[what to change, e.g. 'add Remote EU' or 'exclude Staff titles']"
---

# /preferences

Edit `profile/preferences.json` through conversation, then re-run the search if the user wants.
The same settings are editable in the tracker UI (Settings tab, then **Save & run search**); mention that once.

## Steps

1. Read `profile/preferences.json`. If it doesn't exist, stop and suggest `/onboard`.
2. If `$ARGUMENTS` describes a change, apply it. Otherwise show a compact summary and ask what to change (AskUserQuestion, up to 4 questions):
   - tracks: names, titles, excludeTitles, keywords
   - location: based, acceptableLocations, workModes, remoteScope, work authorization, sponsorship, relocation
   - compensation floor, notice period
   - company stage, size, industries, deal-breakers
   - sources: which boards and providers are enabled, maxAgeDays
3. Rules while editing:
   - Prefer short, broad titles. Track titles match word-in-order with gaps, so `Frontend` matches "SDE 2 - Frontend". Cut noise with `excludeTitles`.
   - `remoteScope` takes only `global` plus the region names in `src/scrape/geo.js`. Never put a country there; the home country comes from `countryCode` and `acceptableLocations`.
   - Turning on a paid provider (googleJobs, apify): explain the monthly budget and the `--paid` gate. Keys go in `.env`, which the user edits themselves. Never ask for a key in chat and never read `.env`.
   - Preserve keys you don't change. Write 2-space JSON.
4. Show a before/after diff of the changed fields and confirm before writing.
5. Write the file, then run `node bin/gaj.js doctor --validate`. Fix any errors it reports; mention warnings.
6. Ask whether to re-run the search now. If yes, follow `/scrape` (it handles the paid-provider question).
   Explain one consequence: on re-run, *new* jobs that no longer match the preferences are marked skipped. Ranked and tracked jobs are kept.
7. If tracks or titles changed, suggest updating track tags in `profile/resume.md` (`<!-- tracks: id -->`) so `/tailor --track` still works.
