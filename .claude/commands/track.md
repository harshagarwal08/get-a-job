---
description: Open the local job tracker web app and summarise what needs attention
argument-hint: "[--port N] [--demo]"
---

# /track

1. Start the tracker in the background (Bash with `run_in_background: true`):

   ```bash
   node bin/gaj.js tracker $ARGUMENTS
   ```

   Wait until the output shows the listening URL (default
   `http://127.0.0.1:4317`) and give it to the user. Port busy → retry with
   `--port 4318`. The server binds to 127.0.0.1 only; stop it by stopping the
   background task.

2. Summarise attention items from `node bin/gaj.js track list --json`
   (skip when `--demo` was passed). Today is the reference date:
   - **Overdue next actions**: `nextActionDate` before today, status not final.
   - **Due this week**: `nextActionDate` within 7 days.
   - **Deadlines**: `deadline` within 7 days and status `saved` or `drafted` (🔥).
   - **Quiet**: status `applied | screening | interview` and `lastActivityAt`
     ≥ 10 days ago → suggest `/followup`; status `applied` and ≥ 45 days →
     suggest the stale sweep in `/followup`.
   - **Drafted but not applied** for ≥ 3 days (by `lastActivityAt`): remind to
     submit, then `/outcome <company> applied`.

   One short table per non-empty group: company · role · status · date · suggested
   command. Nothing due → say so in one line.

3. Briefly list the views: Pipeline (drag cards between statuses), Table
   (search/filter/sort), detail drawer (history, notes, next action), Jobs inbox
   (scraped/ranked jobs with a Track button), Stats, Export (CSV, XLSX, Copy for
   Google Sheets).

4. If there are no applications yet, mention `--demo` to explore with sample
   data (it does not write to `data/tracker.json`), or `/tailor` to create the
   first real application.
