# Contracts

Every module and command relies on these. Change them only through the lead, and update this file at the same time.

## Conventions
- Node ≥ 20, ESM (`"type": "module"`).
- Dependencies are limited to: `puppeteer`, `marked`, `pdfjs-dist`, `exceljs`. Everything else uses Node built-ins (`node:http`, `node:test`, `node:util` parseArgs, global `fetch`).
- Tests use `npm test` (`node --test`, auto-discovers `tests/**/*.test.js`; works on Node 20–24). No network in tests: use fixtures under `tests/fixtures/`.
- Paths always come from `src/lib/paths.js`. JSON read/write goes through `src/lib/store.js` (atomic writes).
- CLI output:
  - Machine-readable JSON on stdout when `--json` is passed; otherwise a human-readable summary.
  - Errors go to stderr, with exit code 1.
- Times are ISO 8601 strings (UTC).

## CLI: `gaj <command>` (`bin/gaj.js`)

The dispatcher maps commands to modules. Each module exports
`export const commands = { '<name>': { summary: string, usage: string, run: async (argv: string[]) => void } }`.

| Command | Module | Purpose |
|---|---|---|
| `scrape [--track id] [--days 14] [--limit N] [--company name] [--paid] [--json]` | scrape | fetch all sources and merge into `data/jobs.json`. Prints counts (new / updated / filtered / per source / errors). |
| `jobs [--status new\|ranked\|...] [--eligibility green\|orange\|unknown] [--track id] [--limit N] [--json]` | scrape | list jobs **without** descriptions |
| `job <key> [--json]` | scrape | one job including its description |
| `jobs:set <key> [--status s] [--quick-fit f] [--rank-file path.json]` / `jobs:set --quick-fit-file map.json` | scrape | update one job (rank file = the `rank` object below, validated strictly), or batch quick-fit from `{"<key>": "high\|medium\|low"}`. |
| `company:check <ats> <slug> [--json]` | scrape | verify a company's public ATS feed. Prints `{ok, ats, slug, jobs: N, sample: [titles]}`; exit 1 if not ok. Used by /onboard to validate `config/companies.json` entries. |
| `careers:check <url> [--json]` | scrape | crawl one careers page (static, then headless Chrome) and report `{ok, url, jobs, sample, method, embeddedAts?}`. NOT pre-approved (reaches arbitrary hosts and runs page JS). A successful check is recorded in `data/cache/careers-checks.json` (url → checkedAt, jobs) for 7 days. |
| `company:detect <name> [--slug s] [--json]` | scrape | find a company's ATS by trying slug variants on every supported ATS. Prints `{name, found: [{ats, slug, jobs, boardName?, confidence: high\|unknown\|low}]}` sorted jobs>0, then confidence, then jobs; exit 1 if none. Never add a `low` match. |
| `companies [--tag t] [--region r] [--json]` | scrape | list `config/companies.json` |
| `companies:add --name N --ats A --slug S [--tags a,b] [--region us,eu] [--stage s] [--source seed\|yc\|discover\|manual] [--url careers-url] [--merge] [--force]` | scrape | verify via company:check (SmartRecruiters with 0 postings is unverifiable unless `--force`), then add. Duplicate ats+slug → "already exists" (returns the stored entry) unless `--merge`. Warns on same name under another ATS. Creates companies.json from the example if missing. |
| `discover yc [--region r[,r]] [--industry x] [--batch W24] [--limit N (default 20)] [--add] [--json]` | scrape | list hiring YC companies (yc-oss public JSON), auto-detect each one's ATS, print matches; `--add` writes high-confidence matches with jobs to companies.json with `source: "yc"`. Detect results cached 7 days. |
| `jobs:import <file.json> [--source linkedin-alert\|email-alert\|manual] [--via platform] [--json]` | scrape | import jobs collected outside the CLI (e.g. LinkedIn alert emails read via Gmail, or a pasted list). File = array of `{title, company, url, location?, description?, postedAt?, workMode?, salary?}`. Runs track match + eligibility + merge (no age filter when `postedAt` missing). Prints counts. |
| `digest [--since ISO \| --hours N] [--mark] [--notify] [--out path] [--json]` | digest | jobs first seen since the last digest (default: since `data/digest-state.json.lastDigestAt`, else 24h), green and unknown first, grouped by track; writes `data/digests/<YYYY-MM-DD>.md`. `--mark` saves now as `lastDigestAt`. |
| `digest --mark-only [--at ISO] [--json]` | digest | set `lastDigestAt` to `--at` (the `generatedAt` of a digest you showed) or now; writes no file. Prints `{lastDigestAt, marked: true}`. |
| `schedule install [--time HH:MM] [--notify] [--yes] \| schedule remove [--yes] \| schedule status [--json]` | digest | daily job that runs `gaj scrape` (free sources only, never `--paid`) then `gaj digest --mark`, logging to `data/logs/`. macOS: a LaunchAgent plist in `~/Library/LaunchAgents/`; Linux: a systemd user timer (cron line fallback); Windows: prints Task Scheduler instructions only. Writes outside the repo, so `install`/`remove` print exactly what they will write and require `--yes`; not pre-approved. |
| `jobs:enrich [--fit high,medium] [--limit 25] [--min-chars 400] [--delay 1500] [--json]` | scrape | fill missing/stub descriptions (< `--min-chars`) for open jobs, best quick fit first, from each posting's own URL via `fetch`. Skips hosts whose terms forbid fetching (Naukri, Glassdoor, Indeed, Wellfound, Instahyre, Cutshort, Weekday, YC) and LinkedIn unless `sources.linkedin`. One locked write at the end. Prints `{tried, filled, failed, skipped: {host, noUrl, linkedin}}`. Also `POST /api/jobs/enrich` in the tracker. |
| `fetch <url> [--json]` | scrape | fetch one posting URL. Recognised ATS URLs use the API; anything else is plain HTML→text. Returns `{url, host, hostClass: 'ats'\|'linkedin'\|'unknown', title?, company?, location?, text}`. |
| `render <resume.md> [--out file.pdf] [--template classic\|modern] [--track id] [--paper letter\|a4] [--html] [--json]` | resume | md → HTML → PDF. `--json` prints `{pdf, html?, pages}`. |
| `verify <file.pdf> [--pages N] [--keywords "a,b,c" \| --keywords-file f] [--json]` | resume | page count, text extraction, ASCII date check, keyword coverage. Exit 1 if `--pages` is exceeded. |
| `ats <file.pdf> [--keywords "a,b,c" \| --keywords-file f] [--json]` | resume | ATS readiness score 0-100 from extracted text: parseability (text, pages, ASCII dates, link URLs visible as text, letter-spaced headings), contact, standard sections, content (length, bullets, numbers, weak phrases), keywords (only when given; otherwise skipped and the score scales to the rest). `--json` prints `{score, grade, keywordsScored, categories, fixes, keywords}`. Always exits 0. |
| `funded [--days N] [--status new\|added\|contacted\|replied\|skipped] [--json]` | funded | list `data/funded.json` (recently funded startups from /funded), newest round first, plus whether a new search is due. `--json` prints `{count, search: {enabled, everyDays, lastSearchAt, daysSince, due, newLeads}, companies}`. `gaj scrape` (without `--company`) includes the same `funded` object in its summary. |
| `funded:add <file.json> [--json]` | funded | merge rounds from a JSON array (file under data/ or the OS temp dir) of `{name, round, amountUsd?, amountText?, announcedAt: YYYY-MM-DD, sector?, city?, country?, investors?, website?, sourceUrl}`. Text is sanitised; `sourceUrl` required; same company keeps the newest round and its status/notes. Records `lastSearchAt` (an empty array just records the search). Prints `{added, updated, unchanged, errors}`; exit 1 only if nothing was added or updated and there were errors. |
| `funded:set <id> [--status s] [--note "..."] [--json]` | funded | update one company's outreach status or append a note. |
| `tracker [--port 4317] [--no-open] [--demo]` | tracker | start the local tracker UI on 127.0.0.1. Besides the CRUD API it serves `GET /api/jobs` (each job adds `descLen`, `tailored`, `funded`), `POST /api/jobs/<key>/description {text}` (50-50,000 chars), `POST /api/jobs/<key>/fetch` (the job's own `applyUrl`/`url` only; LinkedIn only when `sources.linkedin`), `GET /api/applications/<id>/files` (files in its `appDir`, only under `data/applications/`), `GET /api/applications/<id>/outreach` (its `outreach.json` from /outreach, re-validated: plain text, http(s) links, published emails only), `GET /api/templates` (`profile/outreach-templates.json`, else `examples/outreach-templates.example.json`; placeholders `{{company}} {{role}} {{url}} {{name}}`), and `POST /api/agent {task: tailor\|rank\|cover\|cold-dm, key?, id?, kind?}` + `GET /api/agent/status`: one headless `claude -p` run at a time, prompt built only from validated ids, `--permission-mode acceptEdits`, tools limited to Read/Write/Edit/Glob/Grep/WebFetch/WebSearch and `Bash(node bin/gaj.js:*)`. |
| `track add --company C --role R [--url U] [--job-key K] [--status drafted] [--track id] [--fit 72] [--verdict Good] [--resume path] [--cover path] [--channel ats] [--location L] [--work-mode m] [--app-dir path] [--deadline D] [--notes "..."] [--upsert] [--json]` | tracker | add an application, print its id. If `--job-key` already matches a row: exit 1 with `already tracked as <id>` unless `--upsert`, which updates that row instead. |
| `track update <id> [--status s] [--note "..."] [--next-action "..."] [--next-date D] [--field key=value ...]` | tracker | update one application; status changes are appended to history |
| `track list [--status s] [--json]` | tracker | list applications |
| `export [--format csv\|xlsx\|tsv\|json] [--out path]` | tracker | export the tracker (default `data/exports/tracker-<date>.<ext>`) |
| `doctor [--validate]` | lead | check node version, that Chrome launches, that profile files exist; `--validate` checks preferences.json structure |

## Safety rules for CLI writes
- `--out` paths (render, export) must resolve inside `data/`, `profile/`, or the OS temp dir; otherwise exit 1.
- `fetch` refuses loopback, private, and link-local addresses; LinkedIn URLs only when `preferences.sources.linkedin` is true.
- Writes to `data/jobs.json` and `data/tracker.json` hold an exclusive lockfile (`src/lib/store.js` `withLock`) so the scheduled scrape, tracker search and CLI commands can't clobber each other.
- Search-based sources (workday, successfactors) never miss-expire jobs (their results are partial by design); they expire by age (not seen for maxAgeDays*2).
- `.claude/settings.json` allowlists `gaj` per subcommand; `fetch` is intentionally NOT pre-approved (it reaches arbitrary hosts).
- Paid providers (googleJobs, apify) run only when enabled in preferences AND `scrape --paid` is passed (or env `GAJ_ALLOW_PAID=1`); otherwise the summary prints "paid providers skipped (pass --paid)". /scrape asks the user once per session before adding `--paid`.
- Paid usage is recorded in `data/usage.json` (`{ "<YYYY-MM>": { "<provider>": { "requests": n, "usdCap": x } } }`) and enforced before each call against `sources.<provider>.maxRequestsPerMonth` (googleJobs, default 100) / `maxUsdPerMonth` (apify, default 5). Each HTTP attempt (including retries) counts. Hard ceilings regardless of config: googleJobs maxQueries ≤ 20/run; apify maxItems 1–500, maxChargeUsd ≤ 5/actor/run, ≤ 3 actors; jobspy resultsWanted ≤ 100, maxQueries ≤ 5.
- `jobs:import` reads only files under `data/` or the OS temp dir and never echoes file contents in errors.
- Auth headers/keys are dropped on any cross-origin redirect.
- Careers-page URLs come only from `config/companies.json`; crawling goes through safeFetch.

## Files

### `profile/preferences.json` (written by /onboard; example in `examples/preferences.example.json`)
```json
{
  "version": 1,
  "name": "Jane Doe",
  "tracks": [
    { "id": "fe", "name": "Frontend Engineer",
      "titles": ["Frontend Engineer", "Front End Developer", "UI Engineer", "Software Engineer, Frontend"],
      "excludeTitles": ["Intern", "Principal", "Manager"],
      "keywords": ["React", "TypeScript", "Next.js"],
      "resume": "profile/resume.md" }
  ],
  "seniority": ["mid", "senior"],
  "location": {
    "based": "Bengaluru, India",
    "countryCode": "IN",
    "acceptableLocations": ["Bengaluru", "Bangalore", "India"],
    "workModes": ["remote", "hybrid", "onsite"],
    "remoteScope": ["apac", "global"],
    "workAuthorization": ["IN"],
    "needsSponsorship": false,
    "openToRelocation": false
  },
  "compensation": { "currency": "INR", "min": 0, "unit": "year", "note": "" },
  "noticePeriodDays": 60,
  "companyStage": ["seed", "series-a", "series-b", "series-c", "growth"],
  "companySize": ["2-10", "11-50", "51-200", "201-500"],
  "industries": [],
  "languages": [{ "language": "English", "level": "professional" }],
  "dealBreakers": [],
  "sources": {
    "ats": true, "careersPages": true,
    "linkedin": false, "hn": true, "arbeitnow": false, "remotive": true, "remoteok": false,
    "googleJobs": { "enabled": false, "provider": "jsearch", "maxQueries": 6, "maxRequestsPerMonth": 100, "country": "in", "datePosted": "week" },
    "apify": { "enabled": false, "actors": [], "maxItems": 100, "maxChargeUsd": 0.5, "maxUsdPerMonth": 5 },
    "jobspy": { "enabled": false, "sites": ["indeed", "naukri", "glassdoor", "google"], "resultsWanted": 40, "hoursOld": 168, "maxQueries": 3 },
    "maxAgeDays": 14
  }
}
```

### `config/companies.json` (user; seeded from `config/companies.example.json`)
```json
{ "version": 1,
  "companies": [
    { "name": "Acme", "ats": "greenhouse", "slug": "acme", "tags": ["ai", "devtools"],
      "region": ["india"], "stage": "series-a", "source": "seed" }
  ] }
```
`ats` ∈ `greenhouse | lever | ashby | workable | smartrecruiters | recruitee | workday | keka | zohorecruit | successfactors | careers`.
`careers` entries have `"slug": "<company-slug>"` plus a required `"url"`: the company's careers listing page (https). `company:check careers` and `companies:add --ats careers` never crawl: they require a successful `careers:check` of the same URL within 7 days (from the record above) and fail with "run careers:check <url> first" otherwise. Crawled by `src/scrape/sources/careers.js` (see below).
`region` ⊆ `india | us | eu | uk | apac | remote-global` (where the company hires, not HQ only). `stage` ∈ `seed | series-a | series-b | series-c | growth | public | unknown`. `source` ∈ `seed | yc | discover | manual`. All optional except name/ats/slug.
Public endpoints:
- greenhouse: `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`
- lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
- ashby: `https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
- workable: `https://apply.workable.com/api/v1/widget/accounts/{slug}`
- smartrecruiters: `https://api.smartrecruiters.com/v1/companies/{slug}/postings`
- recruitee: `https://{slug}.recruitee.com/api/offers/`

### Enterprise and Indian ATS (owned by the scrape module; section maintained by the scraper agent)
Entries for these ATSs are identified by `"url"` (authoritative); `slug` is derived from it when omitted. `companies:add`/`company:check` require `--url` and validate the host shape; `company:detect <name> --url <careers url>` classifies a URL (no slug guessing: Workday tenants are not guessable). Investigated 2026-10-19 with the honest UA.

Supported (`ats` value → entry `url` → endpoints):
- `workday` → `https://<tenant>.wd<N>.myworkdayjobs.com/<site>` (a `/<locale>/` prefix is accepted and dropped).
  - List: `POST https://<tenant>.wd<N>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs` body `{"appliedFacets":{},"limit":20,"offset":<n>,"searchText":"<track title>"}` → `{total, jobPostings:[{title, externalPath, locationsText, postedOn, bulletFields:[reqId]}]}`. Unknown site → 404, unknown tenant → 422.
  - Detail: `GET …/wday/cxs/<tenant>/<site><externalPath>` → `jobPostingInfo {title, jobDescription(html), location, additionalLocations?, startDate, jobReqId, externalUrl, jobRequisitionLocation.country.alpha2Code}`.
  - Limits: searchText per track title (≤4 terms × ≤3 pages of 20), ≤20 detail requests (title-matched only), one request at a time per company with ≥0.5 s gaps, robots.txt checked for the `/wday/cxs/` path. `postedOn` ("Posted Today/Yesterday/N Days Ago/30+ Days Ago") → date when no `startDate`; `locationsText` "N Locations" → location taken from the `externalPath` segment until the detail fills it. Hosts allowlisted by the suffix rule `<tenant>.wd<N>.myworkdayjobs.com`.
- `keka` → `https://<tenant>.keka.com/careers/`.
  - `GET /careers/` (HTML) → portal GUID from `/ats/documents/<guid>/`; then `GET /careers/api/embedjobs/default/active/<guid>` → `[{id, title, description(html), departmentName, jobLocations:[{city, state, countryCode, countryName}], publishedOn, salaryRange}]`. Job URL `…/careers/jobdetails/<id>`. Unknown tenant redirects to `/careers/Content/TenantNotFound.html`.
  - robots.txt: `Disallow: /` except `Allow: /careers` (both URLs are under it). 2 requests per company. Hosts allowlisted by the suffix rule `<tenant>.keka.com`.
- `zohorecruit` → `https://<tenant>.zohorecruit.(com|in|eu|com.au)/jobs/Careers` or a custom domain serving the same portal (e.g. `https://careers.zohocorp.com/jobs/Careers`).
  - `GET <origin>/jobs/Careers` (HTML); published openings are embedded as JSON in `<input type="hidden" id="jobs" value="[…]">` (`id, Posting_Title|Job_Opening_Name, City, State, Country|Country1, Remote_Job, Job_Description, Date_Opened, Publish`). Job URL `<origin>/jobs/Careers/<id>`. robots allows `/jobs/`. 1 request per company, through safeFetch (custom domains can't be allowlisted).
- `successfactors` → `https://<careers site>` (classic SAP SuccessFactors Recruiting Marketing "RMK" sites, e.g. `careers.tatamotors.com`).
  - `GET <origin>/search/?q=<track title>&locale=en_US&startrow=<0|25>` (server-rendered rows `tr.data-row` → `a.jobTitle-link`, `span.jobLocation` "City, CC", `span.jobDate`); details from the job page (`itemprop="description"`). ≤4 terms × ≤2 pages, ≤10 detail pages, ≥1 s gaps, through safeFetch (robots per URL and per redirect hop).
  - The RSS feeds (`/feeds/<kw>` → `/services/rss/job/`) are robots-disallowed on every RMK site checked, so they are not used. Newer JS-rendered RMK templates (e.g. jobs.standardchartered.com, careers.hcltech.com) have no server-rendered rows: `company:check` fails for them; use `careers` or another ATS.

Unsupported (do not add entries; use `careers` with a careers-page URL, email alerts or `jobs:import`):
- `icims`: no JSON listing; the `?in_iframe=1` HTML differs per tenant, most `careers-<tenant>.icims.com` hosts tried were "gone" (404), and robots.txt redirects. Not stable.
- `darwinbox`: `<tenant>.darwinbox.in/ms/candidateapi/job` answers 500 ("Invalid subdomain"/"Error while getting tenant info") or a 403 WAF page; the careers SPA and robots.txt redirect to `/user/login`. No login-free listing.
- `freshteam`: `<tenant>.freshteam.com/hire/widgets/jobs.json` returns 503/404 (Freshteam is being discontinued).
- `turbohire`: `<tenant>.turbohire.co/robots.txt` is `Disallow: /` for all agents except Googlebot.

### Careers-page crawler (`ats: "careers"`, enabled by `sources.careersPages`)
`src/scrape/sources/careers.js` exports the same interface as other sources: `fetchJobs(company, opts) → NormalizedJob[]`, `normalize(...)`, `fetchOne(url)`, plus `checkCareers(url) → {ok, jobs, method}` used by `company:check careers <slug> --url <url>` and `companies:add --ats careers --url <url>`.
Order: (1) JSON-LD `JobPosting` on the listing page; (2) embedded ATS detection — if the page links/iframes a supported ATS board (greenhouse/lever/ashby/…), report it so the user switches the entry to that ATS; (3) same-site job-detail links (path heuristics) → fetch details (JSON-LD or main-content text), max 25 detail pages per company, title pre-filtered by tracks; (4) if static HTML yields nothing, render with headless Chrome (`src/resume/browser.js` `launchBrowser`) once, then repeat 1–3. Uses safeFetch (private-IP guard, robots.txt per URL, 5 MB cap), ≥1 s between requests to the same host, honest UA. `source: "careers"`. Jobs expire like ATS jobs (missing from 2 consecutive successful crawls).

### Providers (`preferences.sources.{googleJobs,apify,jobspy}`, opt-in, query-based)
Keys live in `.env` (gitignored; template `.env.example`), read via `src/lib/env.js` `getKey('serpapi'|'jsearch'|'apify')`. Keys are never printed, logged, cached, or written to `data/`. Queries = each track's titles × the user's acceptable locations (+ "remote"), capped by `maxQueries`; responses cached 12h in `data/cache/`. Each provider prints its request/charge usage in the scrape summary. Missing key → that provider is skipped with a one-line warning (never a failure).
- `googleJobs` (`provider: "jsearch" | "serpapi"`): JSearch `https://jsearch.p.rapidapi.com/search` (headers `x-rapidapi-key`, `x-rapidapi-host`) or SerpAPI `https://serpapi.com/search.json?engine=google_jobs`. `source: "google-jobs"`; keep the original publisher (LinkedIn/Naukri/Indeed/company) in `via` and prefer the employer's apply link as `applyUrl`.
- `apify`: `actors: [{ "id": "owner~actor-name", "input": { ... } }]` run via `https://api.apify.com/v2/acts/{id}/run-sync-get-dataset-items` with `maxItems` and `maxTotalChargeUsd` = `maxChargeUsd`. Field mapping is heuristic (title/positionName, companyName/company, location, url/jobUrl/link, description/descriptionText, postedAt/publishedAt). `source: "apify"`, `via` = actor id. Never use actors that require the user's LinkedIn cookie or credentials.
- `jobspy`: `linkedin` in `sites` is used only when `sources.linkedin` is true. Runs the open-source `python-jobspy` (pinned version) via `uvx` with an environment stripped of provider keys, (`uvx --python 3.12 --with python-jobspy python src/scrape/providers/jobspy_runner.py <args-json>`), which prints JSON to stdout. Requires `uv`. `source: "jobspy"`, `via` = site. Scraping-based: README/onboard state the ToS caveat.
Provider and imported jobs (`google-jobs | apify | jobspy | linkedin-alert | manual`) expire when not seen for maxAgeDays*2.

### India/startup platforms (Wellfound, Cutshort, Instahyre): email alerts only
A scraper is built only when a listing is public, allowed by robots.txt, needs no login, can be fetched without getting past bot protection, and is not forbidden by the platform's terms. None of the three passes all five checks (investigated 2026-10-19 with the honest UA). So there is **no scraper, no `BOARDS` entry and no `sources.wellfound|cutshort|instahyre` preference**. Jobs come from the user's own alert emails (`/email-alerts`) or pasted lists (`/import-jobs`), via `jobs:import --source email-alert --via <platform>`.
- **Wellfound** (`wellfound.com`, legacy `angel.co`):
  - Role/city SEO pages (`/role/l/<role>/<city>`) return 200 without login. They embed listings in Next.js `__NEXT_DATA__` (Apollo cache, 20 per page) and robots allows them.
  - However, `/search`, `/jobs?jobId=` and `/_jobs/` are disallowed. The site runs behind Cloudflare with bot management.
  - The Terms forbid copying Content "through the use of automated or non-automated harvesting, collection or 'scraping'".
  - Verdict: email alerts only.
- **Cutshort** (`cutshort.io`):
  - `/job/<slug>` pages are public and allowed by robots. `/view/j/`, `/vj/`, `/apply/` and `?job_listing` are disallowed.
  - `sitemap_jobs.xml` lists about 44k job URLs. Job pages carry only `WebPage` JSON-LD; the job data sits in Next.js `__NEXT_DATA__`.
  - The Terms prohibit "any automated process or service to access and/or use the Service" and "systematic or automated data collection".
  - The public API/MCP is a paid recruiter product.
  - Verdict: email alerts only.
- **Instahyre** (`www.instahyre.com`):
  - robots.txt allows everything, and `sitemap-jobs.xml?p=1..387` lists `/job-<id>-<title>-at-<company>-<city>/` URLs.
  - Job pages are AngularJS shells: details load client-side from `/api/v1/…` and there is no `JobPosting` JSON-LD.
  - The Terms forbid "manual or automated software … to crawl or spider any part of the Platform" and to "harvest or scrape" any Content.
  - Verdict: email alerts only.

Parsers live in `src/scrape/boards/{wellfound,cutshort,instahyre}.js`. They are pure and make no network calls; shared helpers are in `alertEmail.js`. Each module exports:
- `PLATFORM`, and `SCRAPER = false`.
- `parseAlertEmail(text) → [{title, company, location, url}]`. Input is the plain-text or HTML email body. A job is anchored on each platform job link, after unwrapping `?url=`-style redirect wrappers. Two card layouts are understood: "details then View-job link" and "title as link anchor". Missing title, company or location fall back to the URL slug (Wellfound `/company/<c>/jobs/<id>-<title>`, Instahyre `…-at-<company>-<city>`). Links with the same normalized URL merge into one job. Entries without both title and company are dropped. Opaque click-trackers (e.g. SendGrid `ls/click?upn=`) are not recognized.
- `isPlatformJobUrl(url)`. Wellfound accepts `/jobs/<id>[-slug]`, `/company/<c>/jobs/<id>[-slug]` and `/jobs?jobId=N`. Cutshort accepts `/job/<slug>-<id>`, `/vj/<id>` and `/view/j/<id>`. Instahyre accepts `/job-<id>[-slug]/`, `/job/<id>[/slug]` and `/candidate/opportunities/?job_id=N`.
- `normalizeJobUrl(url) → string|null`. It always returns https, unwraps redirects, and drops `utm_*`, `ref`, `source` and other tracking params plus the fragment. Job URLs lose their whole query. Hosts are canonicalized: `angel.co` becomes `wellfound.com`, `www.cutshort.io` becomes `cutshort.io`, and `instahyre.com` becomes `www.instahyre.com` with a trailing slash on `/job-…/`.
- `jobFromUrl(url) → {title?, company?, location?}`, the slug info. For Cutshort it is always `{}` because its slugs are ambiguous.

The platforms' alert emails are not published anywhere. The parsers therefore accept many layouts, and the fixtures in `tests/fixtures/platforms/` are synthetic. When a real alert fails to parse, add it (redacted) as a fixture.

### YC jobs board and Weekday: no scraper
Checked 2026-10-21 with the honest UA against the same five tests. There is **no scraper, no `BOARDS` entry and no `sources.yc|weekday` preference**.
- **YC** (`www.ycombinator.com/jobs`, `/jobs/role/<role>`, `/jobs/location/<place>`, `/companies/<slug>/jobs`):
  - Pages return 200 without login and robots allows them (only `/companies?*`, `/library?*` and `/verify/*` are disallowed). Listings are server-rendered as Inertia JSON in the `data-page` attribute (`props.jobPostings`).
  - The Terms of Use (`/legal`) say "you will not engage in or use any data mining, robots, scraping or similar data gathering or extraction methods".
  - Verdict: not built. YC companies come from the yc-oss dataset (`discover yc`) and are scraped through their own ATS.
- **Weekday** (`www.weekday.works`):
  - robots allows `/` except `/drops/` and `/searches/` (`Crawl-delay: 1`); `/jobs` is a public Next.js page.
  - The Terms of Service (`/terms-of-service`, an embedded Google Doc) forbid "any robot, spider, or other automatic device, process, or means to access Service for any purpose, including monitoring or copying any of the material on Service" and say users "shall not scrape or programmatically take any data from Services".
  - Verdict: not built. Use `/import-jobs`.

### Job boards (`preferences.sources.*`, query-based, not per company)
Each board's feed is fetched (cached 6h, failures negatively cached 1h) and filtered locally against track titles, then the same filter/eligibility/merge pipeline runs. Attribution requirements (e.g. RemoteOK) are honored by keeping the source `url`.
- `hn`: latest "Ask HN: Who is hiring?" thread via the HN Algolia API; each top-level comment is one posting (first line usually `Company | Role | Location | REMOTE | VISA`). Expire with the thread (new month = new thread).
- `arbeitnow`: `https://www.arbeitnow.com/api/job-board-api` (Europe; `visa_sponsorship` flag).
- `remotive`: `https://remotive.com/api/remote-jobs?category=software-dev` (remote; the free API ignores category/search, is small and delayed 24h; ≤4 requests/day).
- `remoteok`: `https://remoteok.com/api` (remote; requires a link back to RemoteOK).
- `linkedin`: guest search (unchanged).
Board jobs: `source` = board name; key uses company+title+location as usual; they expire when not seen for maxAgeDays*2 (HN also when a newer thread exists and the comment isn't in it). HN records also carry `roles: string[]`, `visa: boolean`, `hnThread: number`; HN `company` ≤60 chars, `title` ≤120.

### `data/jobs.json` (owned by scrape)
```json
{ "version": 1, "updatedAt": "ISO",
  "jobs": { "<key>": {
    "key": "acme--frontend-engineer--a1b2c3",
    "title": "Frontend Engineer", "company": "Acme",
    "location": "Bengaluru, India", "countries": ["IN"],
    "workMode": "remote|hybrid|onsite|unknown",
    "url": "https://...", "applyUrl": "https://...|null",
    "source": "greenhouse|lever|ashby|workable|smartrecruiters|recruitee|workday|keka|zohorecruit|successfactors|careers|linkedin|hn|arbeitnow|remotive|remoteok|google-jobs|apify|jobspy|linkedin-alert|email-alert|manual",
    "via": "original publisher for aggregated sources (e.g. LinkedIn, Naukri) | null",
    "department": "Engineering|null",
    "salary": { "min": 0, "max": 0, "currency": "INR", "unit": "year" } ,
    "postedAt": "ISO|null", "firstSeen": "ISO", "lastSeen": "ISO",
    "description": "plain text",
    "track": "fe|null",
    "eligibility": "green|orange|unknown", "eligibilityReason": "string",
    "quickFit": "high|medium|low|null",
    "status": "new|skipped|ranked|tracked|expired",
    "rank": null
  } } }
```
`salary` may be `null`. `rank` (written via `jobs:set --rank-file`):
```json
{ "score": 71, "verdict": "Strong|Good|Moderate|Weak|Poor",
  "dimensions": { "technical": 80, "experience": 70, "culture": 60, "career": 75 },
  "gates": { "eligibility": "pass|flag|fail", "compensation": "pass|flag|fail|unknown", "notice": "pass|flag|unknown" },
  "strengths": ["..."], "gaps": ["..."], "note": "...", "rankedAt": "ISO" }
```
Merge rule on re-scrape:
- Keep `firstSeen`, `status`, `quickFit` and `rank`.
- Refresh `lastSeen`, `description` and `salary`.
- A job missing from its source's feed for 2 or more scrapes becomes `expired`.

### Job key: `src/lib/jobKey.js`
`jobKey({company, title, location})` → `${slug(company).slice(0,40)}--${slug(title).slice(0,60)}--${sha1(norm(company)|norm(title)|norm(location)).slice(0,6)}`. Deterministic.

### `data/tracker.json` (owned by tracker)
```json
{ "version": 1, "updatedAt": "ISO",
  "applications": [ {
    "id": "app_<8 hex>",
    "jobKey": "string|null",
    "company": "Acme", "role": "Frontend Engineer", "track": "fe|null",
    "url": "https://...", "location": "Bengaluru", "workMode": "remote|hybrid|onsite|unknown",
    "status": "saved|drafted|applied|screening|interview|offer|hired|rejected|withdrawn|no_response|offer_declined",
    "channel": "ats|referral|linkedin|email|recruiter|other",
    "fit": { "score": 72, "verdict": "Good" },
    "salary": "free text|null", "contact": "free text|null",
    "appDir": "data/applications/<slug>|null",
    "resumePath": "data/applications/<slug>/resume.pdf|null", "coverPath": "string|null",
    "deadline": "YYYY-MM-DD|null", "appliedAt": "ISO|null",
    "nextAction": "string|null", "nextActionDate": "YYYY-MM-DD|null",
    "notes": "string",
    "createdAt": "ISO", "updatedAt": "ISO",
    "history": [ { "at": "ISO", "status": "drafted", "note": "string" } ]
  } ] }
```
- Final statuses: hired, rejected, withdrawn, no_response, offer_declined.
- Stage order (for the funnel's "furthest reached"): saved < drafted < applied < screening < interview < offer < hired.
- Setting status `applied` also sets `appliedAt` if it is empty.
- Quiet time (for /followup) is measured from the last `history[].at`, not `updatedAt`.
- History entries may carry `"undone": true` (UI undo); stats and furthestStage skip undone entries.

### Tracker HTTP API (127.0.0.1 only; mutating routes check Host, Origin and JSON content type)
- Applications: `GET/POST /api/applications`, `GET/PATCH/DELETE /api/applications/:id`, `POST /api/applications/:id/undo`.
- Jobs: `GET /api/jobs` (no descriptions), `GET /api/jobs?key=`, `PATCH /api/jobs/:key {status}`, `POST /api/jobs/:key/track`.
- Preferences: `GET /api/preferences` → `{prefs, exists, errors, warnings, remoteScopes, usage}`; `PUT /api/preferences` validates with `src/lib/preferences.js` (400 on errors), backs up the previous file to `data/backups/preferences-<ISO>.json` (last 10 kept), preserves unknown keys.
- Search: `POST /api/search {paid?, confirmPaid?, track?, days?}` runs `gaj scrape --json` as a child process (one at a time → 409; `paid` requires `confirmPaid`; killed after 10 min; simulated in `--demo`); `GET /api/search/status`.
- Digest/schedule (read-only): `GET /api/digest` → `{lastDigestAt, latest}`, `GET /api/digest/latest` (markdown), `GET /api/schedule/status`. The UI never installs a schedule.
- Stats/export: `GET /api/stats`, `GET /api/export.(csv|tsv|xlsx|json)`; files: `GET /files?path=` (only under `data/applications/`).

### `data/applications/<slug>/` (written by Claude commands; slug = `[a-z0-9-]` of company-role)
- `job_posting.md`: the posting text, verbatim
- `resume.md`, `resume.pdf`, `resume.html`
- `ats_report.md`
- `cover.md`
- `outcome.md`
- `interview_prep_<stage>.md`
- `followup_<date>.md`
- `form_answers.md`

### Digest and Gmail sync state
- `data/digest-state.json`: `{ "lastDigestAt": "ISO|null" }`. Digest markdown starts with `<!-- gaj-digest {since,generatedAt,counts} -->`. `--notify` shows a macOS notification. launchd errors go to `data/logs/launchd.err.log`. `data/digests/<date>.md`: the digest. `data/logs/schedule-<date>.log`: scheduled run output.
- `data/gmail-sync.json`: `{ "lastSyncAt": "ISO|null", "processedMessageIds": ["..."] }` (cap 5000, oldest dropped). Written by `/gmail-sync` and `/email-alerts`.
- `email-alert` imports set `via` to the platform (`linkedin|naukri|indeed|wellfound|instahyre|cutshort|glassdoor|other`).

### `data/research/<company-slug>.json`
`{ company, fetchedAt, expiresAt (+30d), facts: [{claim, source_url}], notes }`. Treat as a lead, never as proof.

### `resume.md` format (owned by resume module; see `examples/resume.example.md`)
```markdown
# Jane Doe
Bengaluru, India · jane@example.com · +91 90000 00000 · [linkedin.com/in/jane](https://linkedin.com/in/jane) · [github.com/jane](https://github.com/jane)

## Summary
Two to four plain sentences.

## Experience
### Senior Frontend Engineer | Acme Health
Jul 2023 - Present | Remote
- Bullet with a real metric. <!-- tracks: fe -->
- Bullet only relevant to another track. <!-- tracks: fde -->

## Projects
### Project name | [link](https://...)
- Bullet

## Skills
- **Languages:** TypeScript, JavaScript
- **Frameworks:** React, Next.js

## Education
### B.Tech, Computer Science | Some University
2019 - 2023
```
Rules:
- `#` is the name. The first paragraph is the contact line, with items separated by ` · `.
- `##` is a section; `###` is an entry, written `Title | Org`. An optional plain line right after it holds `Dates | Location`.
- Bullets are `-`.
- An optional trailing `<!-- tracks: a,b -->` on a bullet keeps it only when rendering with `--track` (bullets without a tag always render). The comment never appears in output.
- Date ranges use an ASCII hyphen with spaces: `Jul 2023 - Present`.
