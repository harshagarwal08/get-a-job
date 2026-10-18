# Setup

Detailed setup for get-a-job. For the short version see the [README](../README.md#quick-start).

- [Install](#install)
- [Pre-commit hook](#pre-commit-hook)
- [Chrome for PDF rendering](#chrome-for-pdf-rendering)
- [Public fork vs private repo](#public-fork-vs-private-repo)
- [Profile files](#profile-files)
- [Company list](#company-list)
- [Job boards](#job-boards)
- [Providers and API keys](#providers-and-api-keys)
- [LinkedIn alerts and pasted results](#linkedin-alerts-and-pasted-results)
- [Cache and rate limits](#cache-and-rate-limits)
- [Running tests](#running-tests)
- [Troubleshooting](#troubleshooting)

## Install

Requirements: Node.js 20+, git, and [Claude Code](https://claude.com/claude-code) signed in with a subscription or an API key.

```bash
node --version                   # v20.x or newer
git clone https://github.com/<you>/get-a-job.git
cd get-a-job
npm install
git config core.hooksPath .githooks
node bin/gaj.js doctor
```

`doctor` prints a check per item, including whether Chrome actually launches. Missing profile files and `config/companies.json` are expected until you run `/onboard`. After onboarding, `node bin/gaj.js doctor --validate` also checks the structure of `profile/preferences.json`, including `location.remoteScope` and the `sources` block.

`git config core.hooksPath .githooks` turns on the pre-commit hook, which runs the privacy guard on what you're committing (see [below](#pre-commit-hook)). It's a per-clone setting, so run it once in each clone.

Optional: `npm link` puts `gaj` on your PATH, so `gaj help` works from anywhere inside the repo. The docs use `node bin/gaj.js` so they work without it.

## Pre-commit hook

`.githooks/pre-commit` runs `.github/scripts/privacy-guard.sh` against the staged index. It blocks the commit if:
- `.gitignore` is missing any of the required personal-data lines, or
- a staged file is under `profile/`, `data/` or `inbox/` (other than `.gitkeep`), or is `config/companies.json`, `.claude/settings.local.json`, `CLAUDE.local.md`, or a `.env` file with your API keys (`.env.example` is allowed).

Enable it once per clone:

```bash
git config core.hooksPath .githooks
```

If it blocks a commit, unstage the file with `git rm --cached <path>`. Don't bypass it with `--no-verify`; CI runs the same check and would fail anyway, after the file is already in your pushed history.

## Chrome for PDF rendering

PDFs are rendered with [puppeteer](https://pptr.dev). There are two ways to give it a browser.

**A. Let puppeteer download Chrome (default).** `npm install` downloads a Chrome for Testing build into `~/.cache/puppeteer` (about 150 MB). Nothing else to do.

**B. Use the Chrome you already have.** Skip the download and point puppeteer at your browser:

```bash
PUPPETEER_SKIP_DOWNLOAD=true npm install

# then, in your shell profile (~/.zshrc, ~/.bashrc):
# macOS
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Linux
export PUPPETEER_EXECUTABLE_PATH="/usr/bin/google-chrome"
# Windows (PowerShell)
$env:PUPPETEER_EXECUTABLE_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

`gaj` looks for a browser in this order:
1. `PUPPETEER_EXECUTABLE_PATH`
2. the Chrome downloaded by puppeteer
3. system Chrome/Chromium: `/Applications/Google Chrome.app/...` on macOS; `/usr/bin/google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `/snap/bin/chromium` on Linux; `Google\Chrome\Application\chrome.exe` under Program Files, Program Files (x86) or LocalAppData on Windows.

So if Chrome is installed in a standard place, `PUPPETEER_SKIP_DOWNLOAD=true npm install` works with no environment variable. Run `node bin/gaj.js doctor` to confirm Chrome launches.

## Public fork vs private repo

### Public fork

Everything personal is gitignored:

| Path | Contents |
|---|---|
| `profile/*` | `preferences.json`, `profile.md`, `resume.md`, rendered PDFs |
| `data/` | `jobs.json`, `tracker.json`, `research/`, `applications/`, `exports/` |
| `inbox/*` | the CV or LinkedIn export you dropped in for `/onboard` |
| `config/companies.json` | your target company list |
| `.claude/settings.local.json`, `CLAUDE.local.md` | your local Claude Code settings and notes (may hold absolute paths or personal notes) |
| `.env`, `.env.*` | any local secrets |

So forking publicly and committing normally is safe. Two rules:

1. Never `git add -f` anything in those paths. `-f` ignores `.gitignore`.
2. Don't remove or weaken those lines in `.gitignore`. The [pre-commit hook](#pre-commit-hook) and CI (`privacy-guard` job) both fail if you do. Enable the hook: CI only runs after you push.

If you commit personal data by accident, removing it in a later commit is not enough; it stays in history. Rewrite history (for example with [`git filter-repo`](https://github.com/newren/git-filter-repo)) and force-push, and treat anything that was pushed publicly as exposed.

### Private repo that still pulls updates

GitHub doesn't let you make a fork of a public repo private. Instead, create an empty private repo and track this one as `upstream`:

```bash
# 1. Create an empty private repo on GitHub, e.g. <you>/get-a-job-private (no README, no license)

# 2. Clone the public repo and re-point origin at your private one
git clone https://github.com/harshagarwal08/get-a-job.git get-a-job-private
cd get-a-job-private
git remote rename origin upstream
git remote add origin git@github.com:<you>/get-a-job-private.git
git push -u origin main

# 3. Don't push to upstream by accident
git remote set-url --push upstream DISABLED

# 4. Later, pull updates
git pull upstream main
git push origin main
```

The gitignore rules still apply in a private repo. Keep them: a private repo can become public later, and collaborators can still see it.

## Profile files

`/onboard` writes these. You can edit them by hand at any time.

| File | Purpose |
|---|---|
| `profile/preferences.json` | Machine-readable search settings: tracks (target titles, excluded titles, keywords), seniority, location and work modes, work authorization, compensation floor, notice period, company stage/size, industries, deal-breakers, sources. Example: [`examples/preferences.example.json`](../examples/preferences.example.json). Schema: [CONTRACTS.md](CONTRACTS.md#profilepreferencesjson-written-by-onboard-example-in-examplespreferencesexamplejson). |
| `profile/profile.md` | Your facts store and the single source of truth for every claim. Metrics here are confirmed by you; anything inferred is labelled. Tailoring may only use what is in this file. Example: [`examples/profile.example.md`](../examples/profile.example.md). |
| `profile/resume.md` | Your master resume in the tailorable markdown format. Bullets can carry `<!-- tracks: fe,fde -->` tags. Example: [`examples/resume.example.md`](../examples/resume.example.md). |

**Tracks** let you search for more than one kind of role at once (say, Frontend Engineer and Forward Deployed Engineer). Each track has its own titles and keywords and can point at its own resume file.

To change a preference later, either edit the JSON or ask Claude ("raise my compensation floor to 40 LPA").

## Company list

`config/companies.json` lists the companies whose ATS feeds and careers pages get scraped. `/onboard` creates it for you: it maps your location, relocation targets and remote scope to region tags and copies the matching entries from `config/companies.example.json`.

The seed list has 177 companies, each verified when the list was built and tagged by region (where they hire) and stage. A company can carry several regions: `us` 137, `uk` 120, `eu` 112, `india` 77, `apac` 75, `remote-global` 50. By source: Ashby 77, Greenhouse 65, careers pages 17, Lever 12, SmartRecruiters 3, Workable 2, Recruitee 1.

To start from the whole seed list instead: `cp config/companies.example.json config/companies.json`.

```json
{ "version": 1,
  "companies": [
    { "name": "Acme", "ats": "greenhouse", "slug": "acme", "tags": ["ai", "devtools"],
      "region": ["india"], "stage": "series-a", "source": "seed" }
  ] }
```

| Field | Values |
|---|---|
| `ats` | `greenhouse`, `lever`, `ashby`, `workable`, `smartrecruiters`, `recruitee`, `careers` |
| `slug` | the company's identifier on that ATS (for `careers`, any short company slug) |
| `url` | required for `careers`: the https careers listing page |
| `region` | any of `india`, `us`, `eu`, `uk`, `apac`, `remote-global` (optional) |
| `stage` | `seed`, `series-a`, `series-b`, `series-c`, `growth`, `public`, `unknown` (optional) |
| `tags` | free-form, e.g. industry (optional) |
| `source` | `seed`, `yc`, `discover`, `manual` (optional; set by the commands) |

List what you have: `node bin/gaj.js companies --region eu`.

### Adding companies

Use the commands rather than editing by hand; they verify the feed first.

```bash
# Don't know the ATS? Detect it.
node bin/gaj.js company:detect "Acme"
node bin/gaj.js company:detect "Acme" --slug acme-inc      # if the obvious slug is wrong

# Add (verifies with company:check, refuses duplicates)
node bin/gaj.js companies:add --name Acme --ats greenhouse --slug acme \
  --tags ai,devtools --region us,eu --stage series-b --source manual

# Already there? Add regions/tags to the existing entry
node bin/gaj.js companies:add --name Acme --ats greenhouse --slug acme --region uk --merge
```

- `companies:add` creates `config/companies.json` from the example if it doesn't exist yet.
- It warns if the same company name is already listed under another ATS.
- A SmartRecruiters board with 0 open postings can't be verified (an unknown slug looks the same). `--force` adds it anyway; use it only when you're sure of the slug.

**Detect confidence.** `company:detect` tries slug variants on every supported ATS and rates each hit:
- `high`: the board's display name matches the company and isn't just the slug you guessed. Safe to add.
- `unknown`: there's no board name, or it only equals the guessed slug. Look at the sample titles before adding.
- `low`: the board name doesn't match the company. Never add these.

Results are cached for 7 days.

### Discovering companies

- **`/discover <criteria>`** in Claude Code, e.g. `/discover Series A-C AI startups in Berlin or London hiring frontend`. It searches, verifies each candidate's ATS, shows a table with an eligibility hint, and adds only the rows you choose.
- **YC directly**:

  ```bash
  node bin/gaj.js discover yc --region eu,uk --industry ai --limit 20
  node bin/gaj.js discover yc --region us --batch W24 --add   # add high-confidence matches with open jobs
  ```

  This reads the public [yc-oss](https://github.com/yc-oss/api) list of hiring YC companies and runs `company:detect` on each. `--limit` defaults to 20. Several regions go in one comma-separated `--region`.

### Finding a slug by hand

Open the company's careers page and hover over an "Apply" link, or check the job page URL:

| URL contains | `ats` | `slug` |
|---|---|---|
| `boards.greenhouse.io/acme`, `job-boards.greenhouse.io/acme`, or `?gh_jid=` on the company's own site | `greenhouse` | `acme` |
| `jobs.lever.co/acme` | `lever` | `acme` |
| `jobs.ashbyhq.com/acme` | `ashby` | `acme` |
| `apply.workable.com/acme` | `workable` | `acme` |
| `jobs.smartrecruiters.com/Acme` | `smartrecruiters` | `Acme` |
| `acme.recruitee.com` | `recruitee` | `acme` |

If the careers page embeds the board, view the page source and search for the ATS names.

### Careers-page entries

For a company with its own careers page and no supported ATS, run `careers:check` on the listing page first. It's the only command that crawls a page that isn't already in your list, so Claude Code asks before running it. A successful check is remembered for 7 days; `companies:add --ats careers` and `company:check careers` refuse the URL without one ("run careers:check <url> first").

```bash
node bin/gaj.js careers:check https://acme.com/careers
# ok, jobs found, sample titles, method (json-ld / links / headless+...), embedded ATS if any
node bin/gaj.js companies:add --name Acme --ats careers --slug acme --url https://acme.com/careers --region india
```

```json
{ "name": "Acme", "ats": "careers", "slug": "acme", "url": "https://acme.com/careers", "region": ["india"] }
```

- Use the page that **lists** jobs, not a single job or the homepage.
- If `careers:check` reports an embedded ATS board (Greenhouse, Lever, Ashby...), switch the entry to that ATS; it's faster and more reliable.
- The crawler uses structured job data when the page has it, otherwise follows same-site job links (at most 25 detail pages per company), and as a last resort renders the page once in headless Chrome. It obeys `robots.txt` and waits at least 1 second between requests to a host.
- `0 jobs` can mean nothing is open, the page is blocked by `robots.txt` (a `5xx` on `robots.txt` also counts as blocked), or jobs only load after a search. Try a more specific listing URL.
- Headless Chrome runs behind a local proxy that blocks private and local addresses, with WebSocket, WebRTC and service workers turned off, one render at a time. A page that needs those won't render.
- Turn the crawler off with `"careersPages": false` in `preferences.sources`.

**Not supported:** Workday (`myworkdayjobs.com`), SAP SuccessFactors, Oracle Taleo, iCIMS, and similar enterprise systems. Their pages are search apps that don't expose a plain list. For those, `/tailor` a posting by its link or pasted text, or bring results in with `/import-jobs`.

### Verifying a company's ATS slug

Use `company:check` first:

```bash
node bin/gaj.js company:check greenhouse acme
node bin/gaj.js company:check lever acme --json
# {"ok":true,"ats":"lever","slug":"acme","jobs":12,"sample":["Frontend Engineer", ...]}
```

It exits 1 if the feed doesn't resolve. `ok` with `jobs: 0` means the slug is right but nothing is open right now.

To see the raw response, `curl` the public endpoint. An error, `404`, or an empty list means the slug is wrong or nothing is open.

```bash
curl -s "https://boards-api.greenhouse.io/v1/boards/acme/jobs" | head -c 400          # {"jobs":[...]}
curl -s "https://api.lever.co/v0/postings/acme?mode=json" | head -c 400              # [...] or {"ok":false}
curl -s "https://api.ashbyhq.com/posting-api/job-board/acme" | head -c 400           # {"jobs":[...]}
curl -s "https://apply.workable.com/api/v1/widget/accounts/acme" | head -c 400       # {"name":..,"jobs":[...]}
curl -s "https://api.smartrecruiters.com/v1/companies/Acme/postings" | head -c 400   # {"totalFound":N,...}
curl -s "https://acme.recruitee.com/api/offers/" | head -c 400                       # {"offers":[...]}
```

Then scrape just that company: `node bin/gaj.js scrape --company Acme`.

## Job boards

Boards are searched by your track titles rather than per company. Turn them on or off in `profile/preferences.json`:

```json
"sources": { "ats": true, "careersPages": true,
             "linkedin": false, "hn": true, "arbeitnow": false, "remotive": true, "remoteok": false,
             "googleJobs": { "enabled": false, ... }, "apify": { "enabled": false, ... },
             "jobspy": { "enabled": false, ... }, "maxAgeDays": 14 }
```

Providers (`googleJobs`, `apify`, `jobspy`) are covered in [the next section](#providers-and-api-keys).

`/onboard` asks which to enable and pre-selects based on where you are and where you want to work (`/onboard update` to change later). `ats` (your company list) stays on.

| Key | What it is | Turn on if |
|---|---|---|
| `hn` | Hacker News "Ask HN: Who is hiring?" monthly thread, via the HN Algolia API. Mostly US/EU startups; posts often say `REMOTE` or `VISA`. | You target the US, EU or UK, want remote-global roles, or need sponsorship. |
| `arbeitnow` | Europe-focused board with a visa-sponsorship flag. | You're in Europe or targeting EU/UK. |
| `remotive` | Remote roles. The free API is small and delayed 24 h, and Remotive asks for at most 4 requests a day. | You want remote roles. |
| `remoteok` | Remote roles. Remote OK requires a link back; each job keeps its `remoteok.com` URL. | You want remote roles with global scope. |
| `linkedin` | LinkedIn's public, logged-out guest job search. | You accept the ToS risk (below). Never pre-selected. |

Board terms in short: keep the source links (the tool does), stay within request limits (the cache does), and don't republish the jobs anywhere. This is a personal tool.

Expect many US/EU board jobs to be tagged **orange** if you're not authorized to work there. Read the `eligibilityReason`; HN `VISA` and Arbeitnow's sponsorship flag are the useful signals.

### LinkedIn (opt-in)

What it does: queries LinkedIn's public guest job search for your track titles and location. It never logs in and never uses your cookies or account.

- LinkedIn's User Agreement restricts automated access. Low-volume use of the guest search is common, but whether it's acceptable is your call.
- Expect `429` or `403` after a burst. The scraper backs off and records the error; other sources are unaffected.
- LinkedIn postings often link to the company's ATS. Use `/tailor` with that ATS URL when you can, and consider adding the company with `company:detect`.

## Providers and API keys

Optional, off by default. `/onboard` (or `/onboard update`) asks which you want and writes the settings. Keys never go in `preferences.json` or in the chat.

### Free vs paid, and budgets

- **Free:** `jobspy` (and every ATS, careers page and board). Runs on every `/scrape`.
- **Paid:** `googleJobs` and `apify`. They run only when enabled in `preferences.sources` **and** you pass `--paid`:

  ```bash
  node bin/gaj.js scrape --paid
  GAJ_ALLOW_PAID=1 node bin/gaj.js scrape      # same, e.g. for a scheduled job
  ```

  Without it the summary says "paid providers skipped (pass --paid)". `/scrape` asks you once per session.
- **Monthly budget:** usage is recorded in `data/usage.json` per month and checked before each call. Every HTTP attempt, retries included, counts.

  | Setting | Default | What it limits |
  |---|---|---|
  | `sources.googleJobs.maxRequestsPerMonth` | 100 | Google for Jobs requests per calendar month |
  | `sources.apify.maxUsdPerMonth` | 5 | sum of Apify per-run charge caps per month, in USD |

- **Hard per-run ceilings** apply regardless of config: Google for Jobs `maxQueries` ≤ 20; Apify ≤ 3 actors, `maxItems` 1–500, `maxChargeUsd` ≤ 5 per actor run; JobSpy `resultsWanted` ≤ 100 and ≤ 5 queries.
- The usage lines in the scrape summary are the **caps** a run was allowed, not what the provider billed. Check the provider's dashboard for real charges, and set a spending limit there too.

### `.env`

```bash
cp .env.example .env      # .env is gitignored
```

Fill only the lines you need, in your editor:

```
SERPAPI_API_KEY=...
JSEARCH_RAPIDAPI_KEY=...
APIFY_TOKEN=...
```

The CLI reads `.env` at startup; real environment variables take precedence. Claude Code is denied from reading `.env` (see `.claude/settings.json`), so edit it yourself. A provider with no key is skipped with a one-line warning; `scrape` doesn't fail. If you paste a key into the chat anyway, Claude writes it to `.env` only when that file doesn't exist yet (it never edits an existing one), and you should rotate the key.

### Google for Jobs (`googleJobs`)

Searches Google's job index, which aggregates LinkedIn, Naukri, Indeed and company sites. Two ways to reach it; pick one with `"provider"`:

| Provider | Where to get a key | Env var |
|---|---|---|
| `jsearch` | [rapidapi.com](https://rapidapi.com): sign up, subscribe to the **JSearch** API (free tier), copy your `X-RapidAPI-Key` | `JSEARCH_RAPIDAPI_KEY` |
| `serpapi` | [serpapi.com](https://serpapi.com): sign up (free tier), copy the API key from your dashboard | `SERPAPI_API_KEY` |

```json
"googleJobs": { "enabled": true, "provider": "jsearch", "maxQueries": 6, "country": "in", "datePosted": "week" }
```

Queries are your track titles times your acceptable locations (plus "remote"), capped at `maxQueries` per run (ceiling 20) and `maxRequestsPerMonth` per month. `country` is your two-letter country code, lowercase. Results are cached 12 hours, so rerunning `/scrape` the same day costs nothing extra.

### Apify (`apify`)

Runs scraper "actors" from the [Apify Store](https://apify.com/store) with your own token. Get it at [console.apify.com](https://console.apify.com) → Settings → API & Integrations, and put it in `APIFY_TOKEN`. New accounts get a small free monthly credit; after that you pay per result.

```json
"apify": { "enabled": true, "maxItems": 100, "maxChargeUsd": 0.5, "maxUsdPerMonth": 5,
           "actors": [ { "id": "owner~actor-name", "input": { "...": "..." } } ] }
```

- `maxItems` and `maxChargeUsd` are passed to Apify for every run and cap what one actor run can return and cost. `maxUsdPerMonth` stops further runs once the month's caps add up to it.
- Runs are started asynchronously with a timeout and memory limit; if one overruns, it's aborted so it doesn't keep billing.
- Pick actors that work without login. Any actor whose input contains cookies, passwords, `li_at` or session tokens is refused.
- Field mapping is best-effort; check a few imported jobs after the first run.

### JobSpy (`jobspy`)

Free, open-source scraper ([python-jobspy](https://pypi.org/project/python-jobspy/)) for LinkedIn, Indeed, Naukri, Glassdoor and Google. It runs locally through `uvx`, so you need [uv](https://docs.astral.sh/uv/):

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
# or: brew install uv
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

uv --version
```

The first run downloads Python 3.12 and JobSpy (pinned to python-jobspy 1.3.0) into uv's cache. The JobSpy process runs without your API keys or other secrets in its environment.

```json
"jobspy": { "enabled": true, "sites": ["linkedin", "indeed", "naukri", "glassdoor", "google"], "resultsWanted": 40, "hoursOld": 168 }
```

JobSpy scrapes those sites directly from your IP. Their terms may forbid it and they may rate-limit or block you. Keep `resultsWanted` modest (ceiling 100). The `linkedin` site is skipped unless `sources.linkedin` is true.

## LinkedIn alerts and pasted results

Two ways to get jobs from sites the scraper doesn't cover, with no scraping:

**`/linkedin-alerts`**
1. On LinkedIn → Jobs, search a target title and location, set filters, and turn on **Set alert** with daily email. One alert per title × location.
2. In Claude, connect the Gmail connector (claude.ai → Settings → Connectors → Gmail).
3. Run `/linkedin-alerts` (optionally `/linkedin-alerts 14` for the last 14 days). Claude reads the alert emails read-only, extracts the jobs and imports them with `gaj jobs:import`. It never changes, sends or deletes email.

**`/import-jobs`**: browse any job site yourself, copy the results list (or a list of job links), run `/import-jobs` and paste. Claude extracts title, company, location and link and imports them. It doesn't open the pasted links.

Both go through the same matching, eligibility tagging and de-duplication as `/scrape`. To import a file you built yourself:

```bash
node bin/gaj.js jobs:import data/my-jobs.json --source manual
# data/my-jobs.json: [{"title": "...", "company": "...", "url": "https://...", "location": "..."}]
# The file must be under data/ or the OS temp dir.
```

## Cache and rate limits

`data/cache/` holds:
- board feeds, cached 6 hours (failed fetches 1 hour), so repeated `/scrape` runs in a day don't hit the boards again
- `company:detect` / `discover yc` results, cached 7 days
- the yc-oss hiring list, cached 24 hours
- provider responses (Google for Jobs, Apify, JobSpy), cached 12 hours

It's gitignored (inside `data/`) and **safe to delete** at any time; the next run refetches. Delete it if you want fresh board results before the 6 hours are up, or if a detect result is stale because a company changed ATS.

Rate limits to know about:
- **Workable** throttles quickly. Detection probes Workable one request at a time with a 1-second gap, and if it answers `429` it's skipped for the rest of that run. A big `discover yc` can report Workable as rate-limited; rerun later for those companies.
- Other ATSs are probed with a small number of parallel requests each; any ATS that returns `429` is skipped for the rest of the run.
- **Remotive**: at most 4 requests a day. Don't delete the cache in a loop.
- **Paid providers**: deleting the cache makes the next `/scrape --paid` call them again and spend again (within the monthly budget). `data/usage.json` is the budget ledger; deleting it resets the month's count, so don't.
- **Careers pages**: at least 1 second between requests to the same host; one headless render per page at most.
- **LinkedIn**: see above.

## Running tests

```bash
npm test
```

`npm test` runs `node --test`, which finds every `tests/**/*.test.js` file. It works on Node 20 through 24. To run one file: `node --test tests/tracker.test.js`.

Tests use fixtures in `tests/fixtures/` and make no network calls. Tests that need Chrome (PDF rendering) skip themselves when no browser is available.

Run the same checks CI runs before pushing:

```bash
bash .github/scripts/privacy-guard.sh   # personal data ignored and untracked
bash .github/scripts/prompt-lint.sh     # no unrestricted Bash in .claude/settings.json
```

## Troubleshooting

**`doctor` says Chrome is missing / `Could not find Chrome`**
- Run `npx puppeteer browsers install chrome`, or
- set `PUPPETEER_EXECUTABLE_PATH` to an installed Chrome (see [above](#chrome-for-pdf-rendering)).

**Chrome fails to launch on Linux (`error while loading shared libraries`, sandbox errors)**
- Install the libraries Chrome needs: on Debian/Ubuntu, `sudo apt-get install -y libnss3 libatk-bridge2.0-0 libgbm1 libxkbcommon0 libasound2` (package names vary by release).
- In containers, CI or WSL without a working Chrome sandbox (`No usable sandbox!`), set `GAJ_NO_SANDBOX=1`. `gaj` then retries the launch with `--no-sandbox`. It does this automatically when running as root on Linux, and never otherwise. Only use it on a machine you trust.

```bash
GAJ_NO_SANDBOX=1 node bin/gaj.js render profile/resume.md
```

**`render` or `export` says `refusing to write ...: output must be inside data/, profile/ or <tmp>`**
- `--out` is restricted to `data/`, `profile/` and the OS temp dir, so a bad path (or an injected one) can't overwrite files elsewhere. Write there and copy the file out yourself.
- Rendering a file from `examples/` without `--out` writes to `<tmp>/gaj-render/`.

**`403` or `429` during scrape or discovery**
- From LinkedIn: expected occasionally. Wait, scrape less often, or turn LinkedIn off.
- From Workable during `company:detect` / `discover yc`: it throttles. Wait a few minutes and rerun; cached results aren't refetched.
- From another ATS or a board: rare. Check the slug with `company:check` (above). Corporate proxies and VPNs sometimes block these hosts. Board failures are retried after an hour.

**A provider was skipped**
- `paid providers skipped (pass --paid)`: expected; run `scrape --paid` or answer yes in `/scrape`.
- Monthly budget reached: raise `maxRequestsPerMonth` / `maxUsdPerMonth`, or wait for next month.
- `no ... key in .env`: add the key (see [Providers](#providers-and-api-keys)).
- JobSpy: `uv` not found. Install it and check `uv --version`.

**`companies:add --ats careers` says "run careers:check <url> first"**
- Run `node bin/gaj.js careers:check <url>`. If it finds jobs, add again within 7 days.

**Scrape finds nothing**
- `config/companies.json` missing or empty: run `/onboard`, `/discover`, or copy the example.
- No boards enabled and few companies: turn on `hn`, `remotive` etc. in `preferences.sources`.
- Slugs wrong: run `node bin/gaj.js company:check <ats> <slug>` for each.
- Filters too narrow: check `tracks[].titles`, `excludeTitles`, `location.acceptableLocations` and `workModes` in `preferences.json`. Try `--days 30`.
- Run `node bin/gaj.js scrape --json` to see per-source counts, how many jobs were filtered out, and errors.

**Tailored PDF is more than one page**
- `gaj verify --pages 1` exits 1 and `/tailor` should trim before finishing. If you're editing by hand: drop the oldest or least relevant bullets, shorten the summary, merge skill lines, or render with `--track` so bullets tagged for other tracks are dropped.
- Try the other template: `--template classic` vs `--template modern`.

**Tracker port in use**
- `node bin/gaj.js tracker --port 4318`.

**More detail on errors**
- `GAJ_DEBUG=1 node bin/gaj.js <command>` prints stack traces.
