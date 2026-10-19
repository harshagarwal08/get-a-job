---
description: Show jobs found since the last digest, offer to rank them, and set up a daily scheduled scrape
argument-hint: "[--hours N | --since ISO]"
---

# /digest

Load `.claude/skills/get-a-job/SKILL.md`.

## 1. Build the digest

```bash
node bin/gaj.js digest $ARGUMENTS --json
```

Run it **once**. Default window: since the last mark (or 24h). The CLI also
writes `data/digests/<YYYY-MM-DD>.md`; give that path. Keep `generatedAt` from
the JSON for step 3.

## 2. Summarise

- Count of new jobs, by eligibility.
- **Green and unknown first, grouped by track**: `title | company | location |
  mode | source (via) | key`. Mark ⚠ for postings older than 30 days.
- Orange collapsed: count plus one line each with the reason.
- Nothing new → say so, and suggest `/discover`, `/email-alerts`, or more
  sources in `preferences.sources`.

## 3. Offer next steps

Ask (AskUserQuestion): rank the green/unknown ones now (`/rank` on those keys),
tailor one (`/tailor <key>`), or nothing.

Then mark exactly the digest you showed as seen (ask first if the user skipped
review); do not re-run the digest:

```bash
node bin/gaj.js digest --mark-only --at <generatedAt from step 1>
```

Jobs that arrived after `generatedAt` stay in the next digest.

## 4. Daily schedule (offer once, if not already installed)

1. `node bin/gaj.js schedule status` (prompts; schedule is not pre-approved).
2. If not installed, explain: it runs `gaj scrape` with free sources only
   (never `--paid`) and then `gaj digest --mark` every day, logging to
   `data/logs/`. On macOS it writes a LaunchAgent in `~/Library/LaunchAgents/`;
   on Linux a systemd user timer (cron fallback); on Windows it only prints Task
   Scheduler steps. Because it writes outside the repo, it asks permission.
3. Dry run, show the output:
   `node bin/gaj.js schedule install --time 08:00` (ask for the time first).
4. Only after the user agrees to what it printed:
   `node bin/gaj.js schedule install --time <HH:MM> --yes`.
5. Remove later with `node bin/gaj.js schedule remove` then `--yes`.

Alternatives without a system job: Claude Code's `/loop` (e.g. `/loop 24h
/digest` while a session is open) or the `schedule` skill for a cloud routine.
A cloud routine cannot see this machine's `data/`, so prefer the local schedule.
