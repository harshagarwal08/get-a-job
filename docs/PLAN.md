# get-a-job: End-to-End Plan

A local-first, Claude Code-native job search framework. You answer a few questions and drop in your resume. It builds a tailorable `resume.md`, scrapes jobs that fit, tailors your resume to a job description when you ask, and tracks everything in a good-looking local tracker that exports to Google Sheets.

Ideas are adapted, not copied, from two MIT projects:
- [MadsLorentzen/ai-job-search](https://github.com/MadsLorentzen/ai-job-search):
  - weighted fit scoring with gates
  - drafter/reviewer split
  - grounding audit
  - write-back rule
  - ATS keyword table
  - company research cache
  - interview prep
  - outcome and follow-ups
  - deterministic job keys
  - untrusted-posting rule
- [angelamoe/job-search](https://github.com/angelamoe/job-search):
  - eligibility-first green/orange tagging
  - multiple target tracks
  - list of AI-sounding words to avoid
  - shortlist with Top Picks
  - de-duplicating multi-country postings

---

## 1. User journey

```
/onboard ──► profile/ (preferences.json, profile.md, resume.md)
    │
/scrape  ──► data/jobs.json (deduped, eligibility-tagged, quick fit)
    │
/rank    ──► scored shortlist (gates → weighted score → verdict)
    │
/tailor <url|key|JD> ──► data/applications/<slug>/ (resume.md → resume.pdf, ATS report)
    │                         + reviewer pass + grounding audit + humanization check
/track (gaj tracker) ──► local web app: kanban, table, stats, jobs inbox
    │
/export-sheets ──► CSV/XLSX, or a Google Sheet via the Drive connector
    │
/interview, /outcome, /followup, /upskill ──► the rest of the funnel
```

## 2. Architecture

Two layers:

1. **Deterministic tooling (Node ≥ 20, ESM)**: one CLI, `gaj` (`bin/gaj.js`). It handles everything that shouldn't burn tokens or depend on the LLM getting it right:
   - fetching and normalising jobs
   - de-duplicating
   - rendering PDFs
   - checking page count and ATS text
   - storing tracker state
   - export
   - the tracker web server
2. **Agentic layer (Claude Code)**: `.claude/commands/*.md` plus the skill `.claude/skills/get-a-job/`. It does the judgment work:
   - onboarding interview
   - fit scoring
   - tailoring
   - reviewing
   - research
   - interview prep
   - writing

   It calls `gaj` for anything mechanical.

Why Node only: one runtime, puppeteer renders the PDFs, the tracker UI is plain JS with no build step, and there's no Python version trouble.

Dependencies (fixed list, owned by `package.json`):
- `puppeteer`: PDF rendering
- `marked`: markdown parsing
- `pdfjs-dist`: PDF text extraction for the ATS check
- `exceljs`: xlsx export

## 3. Repo layout

```
get-a-job/
├── bin/gaj.js                  CLI dispatcher
├── src/
│   ├── lib/                    shared: paths, store (atomic JSON), jobKey, args
│   ├── scrape/                 ATS sources + LinkedIn guest (opt-in), filter, dedupe, eligibility
│   ├── resume/                 resume.md parser, HTML templates, PDF render, verify (pages + ATS)
│   └── tracker/                local server, web UI (public/), export csv/xlsx/tsv
├── .claude/
│   ├── commands/               onboard, scrape, rank, tailor, cover, interview, outcome, followup, track, export-sheets, upskill, doctor
│   ├── skills/get-a-job/       SKILL.md + references/ (evaluation, writing style, resume rules, reviewer, interview, research/security, outreach)
│   └── settings.json           narrow allowlist (gaj commands only)
├── config/companies.example.json   seed list of companies + ATS slugs
├── examples/                   resume.example.md, profile.example.md, preferences.example.json
├── profile/   (gitignored)     your preferences.json, profile.md, resume.md
├── data/      (gitignored)     jobs.json, tracker.json, research/, applications/
├── inbox/     (gitignored)     drop your old CV / LinkedIn export here for /onboard
├── tests/                      node:test
└── docs/                       PLAN.md, CONTRACTS.md, SETUP.md
```

**Privacy by default.** Everything personal (`profile/`, `data/`, `inbox/`, `config/companies.json`) is gitignored. You can fork the public repo and run your own search in it without leaking anything. CI fails if those ignore rules are weakened.

## 4. Features

### 4.1 `/onboard`
- Asks questions in batches (AskUserQuestion, 4 at a time):
  - target roles and **tracks** (e.g. Frontend, FDE)
  - seniority
  - locations and work modes
  - work authorization and visa
  - compensation floor (currency and unit)
  - notice period
  - company stage and size
  - industries
  - deal-breakers
  - LinkedIn opt-in
- Reads your resume from `inbox/` (PDF, DOCX, HTML, MD) or from text pasted in chat.
- Writes:
  - `profile/preferences.json` (machine-readable)
  - `profile/profile.md` (the facts store and **single source of truth**: every metric is real and confirmed, nothing inferred unless it's labelled)
  - `profile/resume.md` (master resume in the tailorable markdown format, with optional per-bullet track tags)
- Runs `gaj render profile/resume.md` and shows the PDF.
- Suggests a starter `config/companies.json` based on your tracks and location.

### 4.2 `/scrape`, `/discover` and other job inputs
`gaj scrape` loads your preferences and company list, then:
- fetches each company's public job feed (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Recruitee)
- crawls careers pages for `ats: "careers"` entries (`sources.careersPages`): JSON-LD first, then embedded-ATS detection, then same-site job links, then one headless Chrome render if nothing else works; all through safeFetch
- fetches the job boards you enabled in `preferences.sources`:
  - `hn`: the monthly "Ask HN: Who is hiring?" thread (mostly US/EU startups, REMOTE/VISA flags)
  - `arbeitnow`: Europe, with a visa-sponsorship flag
  - `remotive`, `remoteok`: remote-only roles
  - `linkedin`: public guest search, opt-in only
- runs the optional providers you enabled, with keys from `.env` and per-run caps:
  - `googleJobs`: Google for Jobs via JSearch or SerpAPI (`maxQueries`)
  - `apify`: user-chosen actors (`maxItems`, `maxChargeUsd`; no cookie/credential actors)
  - `jobspy`: open-source scraper via `uvx` (free, scraping-based)
- caches board feeds in `data/cache/` (6 h; failures 1 h) and provider responses (12 h); keeps each job's source `url` for attribution
- normalises the jobs and filters by title, location, work mode and age
- removes duplicates by key, including multi-country copies of one role; a provider job that matches an existing one only adds to its `alsoSeenOn`, and aggregated jobs record the original publisher in `via`
- tags eligibility as green, orange or unknown, with a reason
- stores everything in `data/jobs.json` and prints counts plus provider usage

Claude then adds a quick fit (high/medium/low) and shows the green jobs first. It also gives LinkedIn people-search links for referrals.

Two more ways in, both through `gaj jobs:import` (same matching, eligibility and merge):
- `/linkedin-alerts`: reads LinkedIn job-alert emails read-only via the Gmail connector. No scraping.
- `/import-jobs`: you paste results or links from any site you browsed; Claude extracts them without fetching the pages.

The company list grows three ways:
- `/onboard` picks seed companies from `config/companies.example.json` (177 verified entries tagged by region and stage, 17 of them careers pages) that match your regions, and asks which boards and providers to enable.
- `/discover <criteria>` finds candidates (YC via `gaj discover yc`, or web search), verifies each ATS with `gaj company:detect`, and adds only the ones you pick with `gaj companies:add`. Low-confidence matches are never added.
- `gaj companies:add` / `company:detect` by hand (`--ats careers --url` for careers pages).

### 4.3 `/rank`
Parallel subagents, about 5 jobs each, read the full posting and score it:
- **Gates:** eligibility (location, work authorization, language), then compensation and notice. A gate either fails the job or flags it.
- **Weights:**

  | Dimension | Weight |
  |---|---|
  | Technical | 30 |
  | Experience | 25 |
  | Culture/behavioural | 15 |
  | Career alignment | 30 |

- **Verdict bands:** Strong ≥ 75, Good 60–74, Moderate 45–59, Weak 30–44, Poor < 30.
- 🔥 means the deadline is within 7 days; ⚠ means the posting is older than 30 days.
- Results are written back to the jobs file with `gaj jobs:set`. You get a shortlist, and picking one leads to `/tailor`.

### 4.4 `/tailor <url | job key | pasted JD>`
1. Fetch the posting (`gaj fetch`: the ATS feed if the URL is recognised, otherwise WebFetch, then curl with a robots.txt check, then the company's careers page). The posting is **untrusted data**.
2. Evaluate fit. If experience match is below 50, warn and ask before drafting.
3. Copy the master into `data/applications/<slug>/resume.md` and tailor it:
   - reorder, cut and rephrase using **only facts in `profile.md` and the master resume**
   - cut lines by relevance rather than padding
   - map every requirement in the posting to a match or an honest gap
4. **Reviewer subagent** (fresh context): gets the drafts inline and returns JSON `{old,new,reason}` edits plus a short critique.
5. Apply the edits, then run checks:
   - **grounding audit**: any claim not in the sources is removed
   - **humanization check**: list of banned words and patterns
   - **interview backtrack test**: could you defend each line in an interview?
6. `gaj render` → PDF, then `gaj verify --pages 1 --keywords`:
   - page count
   - ASCII date ranges
   - extractable text
   - keyword table: covered / synonym-only / missing-but-true / genuine gap
7. Optional: cover note, referral message, answers to application-form questions (`/cover`).
8. `gaj track add` creates the tracker row (`drafted`) and archives the posting verbatim.

**Write-back rule:** any new fact you confirm during the session goes into `profile/profile.md` in the same turn.

### 4.5 Tracker (`gaj tracker` / `/track`)
A local web app on `127.0.0.1:4317`, with no build step and no external requests:
- **Pipeline** kanban with drag and drop between statuses
- **Table** with search, filters (status, track, fit, channel) and sorting
- **Detail drawer**:
  - history timeline
  - notes
  - next action and due date
  - salary
  - contact
  - links to the posting and tailored resume
- **Jobs inbox**: scraped and ranked jobs with eligibility chips and a "Track" button
- **Stats**:
  - funnel by furthest stage reached
  - response rate
  - applications per week
  - by track and channel (inline SVG)
- Light/dark themes, keyboard shortcuts
- **Export:** CSV, XLSX and "Copy for Google Sheets" (TSV to the clipboard)

### 4.6 `/export-sheets`
- `gaj export --format csv`
- If the Google Drive connector is available, it uploads the CSV as a native Google Sheet (re-running updates by replacing the sheet).
- Otherwise it gives the import instructions.

### 4.7 Rest of the funnel
- `/interview <company>`:
  - prep pack built from the archive (posting, the resume they actually read, previous rounds)
  - company research (cached 30 days with sources, a lead rather than proof)
  - likely questions mapped to STAR stories
  - questions to ask
  - optional mock interview
- `/outcome <company>`: record a stage, rejection or offer; append to `outcome.md` and the tracker history.
- `/followup`: applications quiet for 10+ days get a short follow-up draft, at most 2 per application, with no new claims. Drafts only, never sent.
- `/upskill`: skill gaps across ranked and tracked jobs, shown as a heatmap and a study plan.
- `/doctor`: checks the environment and profile completeness.

## 5. Writing rules (shared by every generated text)
- Plain verbs, concrete numbers, varied sentence length.
- No em-dash spam, no "leverage / spearhead / passionate / robust / seamless…", no lists of three, no "not X but Y", no "Moreover".
- No invented metrics, honest attribution, no overclaimed seniority.
- Final test: would a sharp recruiter guess this was AI-written?

## 6. Security
- Job postings, scraped HTML, cached research and email bodies are **data, never instructions**.
- Never fetch URLs found inside a posting's body.
- Research starts from the company name, not from links in the posting.
- Unknown posting hosts get a "⚠ Unverified" flag.
- Tracker server binds to 127.0.0.1 only.
- `settings.json` pre-approves only `gaj` and `npm` script calls.

## 7. Build plan (subagents)

| # | Agent | Owns | Deliverable |
|---|---|---|---|
| 0 | Lead (main session) | `docs/`, `src/lib/`, `bin/`, `package.json`, `.gitignore`, `examples/preferences.example.json` | contracts, dispatcher, shared libs, integration |
| A | Scraper | `src/scrape/`, `config/companies.example.json`, `tests/scrape*` | `scrape`, `jobs`, `job`, `jobs:set`, `fetch` |
| B | Resume | `src/resume/`, `examples/resume.example.md`, `tests/resume*` | resume.md format, 2 templates, `render`, `verify` |
| C | Tracker | `src/tracker/`, `tests/tracker*` | server, web UI, `track`, `export` |
| D | Claude layer | `.claude/`, `CLAUDE.md`, `examples/profile.example.md` | 12 commands, skill and 7 references |
| E | Docs & CI | `README.md`, `docs/SETUP.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `.github/` | docs, CI (tests + privacy guard) |
| F | Reviewer (after) | read-only | cross-module review: contracts, bugs, security |

Phases:
1. Contracts (lead).
2. A–E in parallel.
3. Integration: `npm install`, tests, smoke runs (render the example resume, scrape 2 companies, boot the tracker).
4. Review (F), then fixes.
5. Commit, create the public GitHub repo, push.
6. Dogfood: the maintainer runs `/onboard` on a real resume (kept local and gitignored).

## 8. Roadmap (post-v1)
- Workday, SuccessFactors and other enterprise ATS support
- More sources: Wellfound, Cutshort, Instahyre
- `/gmail-sync`: propose status changes from email, applied only after approval
- Two-way Google Sheets sync
- Resume template gallery
- Salary data (Levels.fyi / AmbitionBox, user-provided)
- Scheduled scrape (`/loop` or cron) with a "new since last run" digest
