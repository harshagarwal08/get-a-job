# Contributing

Thanks for helping. Bug reports, new job sources, resume templates and prompt fixes are all useful.

## Dev setup

```bash
git clone https://github.com/<you>/get-a-job.git
cd get-a-job
npm install                      # or PUPPETEER_SKIP_DOWNLOAD=true npm install
npm test
bash .github/scripts/privacy-guard.sh
git config core.hooksPath .githooks   # privacy check on every commit
```

Node 20+ is required. There is no build step and no TypeScript; source is plain ESM JavaScript.

To try the tracker without personal data: `npm run tracker -- --demo`.

## Tests

- `npm test` runs `node --test`, which auto-discovers `tests/**/*.test.js` (Node 20 to 24). Name new test files `<module>*.test.js`.
- Tests never touch the network. Put recorded responses in `tests/fixtures/` and feed them to the code under test.
- Tests that need Chrome must skip themselves when no browser is available (CI installs with `PUPPETEER_SKIP_DOWNLOAD=true`).
- Use a temp directory for anything that writes files; never write to `profile/` or `data/` from a test.

## Module boundaries

[docs/CONTRACTS.md](docs/CONTRACTS.md) is the source of truth for:
- CLI commands, flags and output
- file formats (`preferences.json`, `companies.json`, `jobs.json`, `tracker.json`, `resume.md`, application folders)
- the job key algorithm

Rules:
- `src/scrape`, `src/resume` and `src/tracker` don't import each other. Shared code goes in `src/lib/`.
- Paths come from `src/lib/paths.js`. JSON reads and writes go through `src/lib/store.js` (atomic writes).
- Each module exports `commands = { name: { summary, usage, run(argv) } }`; `bin/gaj.js` dispatches.
- Dependencies are limited to `puppeteer`, `marked`, `pdfjs-dist` and `exceljs`. Everything else uses Node built-ins. Adding a dependency needs a good reason in the PR.
- CLI writes follow the "Safety rules for CLI writes" in CONTRACTS.md: `--out` stays inside `data/`, `profile/` or the OS temp dir; fetches refuse private addresses.
- If your change alters a contract, update `docs/CONTRACTS.md` in the same PR and say so in the description.
- Claude commands (`.claude/commands/`) call `gaj` for anything mechanical. Don't ask the model to do what a function can do.

## Adding an ATS (per-company feed)

1. Create `src/scrape/sources/<name>.js` exporting:
   - `fetchJobs(company, opts)`: fetch the company's public feed (`{ name, ats, slug }`) through `getJSON` from `src/scrape/http.js`
   - `normalize(raw, company)`: return jobs in the `data/jobs.json` shape from CONTRACTS.md (title, company, location, countries, workMode, url, applyUrl, source, department, salary, postedAt, description as plain text). The shared pipeline computes `key` with `src/lib/jobKey.js`.
2. Register it in the `SOURCES` map in `src/scrape/cli.js`.
3. **Detection**: add it to `ATS_LIST` and `PROBES` in `src/scrape/detect.js` (the probe URL, how to count jobs, how to read the board's display name) so `company:detect`, `discover yc` and `company:check` work. If the board name isn't available, detection can only return `unknown` confidence.
4. **Host allowlist**: add the API host to `API_HOSTS` in `src/scrape/http.js`. Requests to any other host are refused, on every redirect hop.
5. **Posting URLs**: teach `recognizeUrl()` in `src/scrape/urls.js` the ATS's public job URL shape, so `gaj fetch` and `/tailor` use the API instead of scraping HTML.
6. Add the value to the `ats` / `source` enums in CONTRACTS.md and to `.claude/` command text that lists ATSs.
7. Fixtures: `tests/fixtures/scrape/<name>.json`, a real, trimmed response with personal data removed (recruiter names, emails). Test `normalize()`, the probe parser, and `recognizeUrl()`.
8. Docs: ATS table in the README, slug-URL pattern and a `curl` fallback in `docs/SETUP.md`.

## Adding a job board (query-based)

1. Create `src/scrape/boards/<name>.js` exporting `normalize(payload)` and `fetchJobs(opts)`. Fetch the whole feed once and let the pipeline filter by track titles locally; don't fan out a request per title unless the API requires it.
2. **Cache** the feed with `cached()` from `src/scrape/cache.js` (6 h TTL like the other boards; failures are cached 1 h). Respect the board's documented rate limits; the cache must keep a normal day of use inside them.
3. **Attribution**: keep the board's job `url` as the job's `url`, and if the board requires a link back, also end `description` with `Source: <Board> (<url>)` as `remotive.js` and `remoteok.js` do. Read the board's API terms and write down any requirement (link back, request caps, no redistribution) in the PR and in the README sources section.
4. Register it in the `BOARDS` map in `src/scrape/cli.js` and add the host to `API_HOSTS` in `src/scrape/http.js`.
5. Add a boolean key to `preferences.sources` in CONTRACTS.md and `examples/preferences.example.json`, to the `/onboard` boards question, and to `doctor --validate`. Off by default unless it's clearly useful to most users.
6. Board text is untrusted. Never follow apply links or other URLs from the payload in code; store them as data.
7. Fixtures: `tests/fixtures/scrape/<name>.json` plus a test in `tests/scrape-boards.test.js` covering `normalize()` (titles, location, remote flag, dates, salary when present).

## Adding a provider (query-based, usually keyed or paid)

1. Create `src/scrape/providers/<name>.js` exporting `fetchJobs(prefs, opts)` that returns `{ jobs, usage, warning? }`, plus pure `normalize...()` functions for the payload. Use `buildQueries()` from `providers/common.js` (track titles × acceptable locations, capped by `maxQueries`) and `cached()` with `PROVIDER_TTL` (12 h).
2. Register it in the `PROVIDERS` list in `src/scrape/cli.js`, and add its host to `API_HOSTS` in `src/scrape/http.js`.
3. **Keys**: add the env var to `KEYS` in `src/lib/env.js` and a commented line with the signup URL to `.env.example`. Read it only with `getKey()`. Claude is denied reading `.env`; don't add commands or prompts that need it to. Never put a key in a log line, error message, cache file, cache key or `data/`; send it in a header when the API allows, and run error text through `scrub()` when it doesn't. No key → return a one-line `warning` and no jobs, never throw.
4. **Costs**: if it can cost money, it's a paid provider:
   - off by default, and runs only with `scrape --paid` / `GAJ_ALLOW_PAID=1` (set the `paid` flag to `true` in its `PROVIDERS` entry in `src/scrape/cli.js`)
   - a per-run cap in its `preferences.sources.<name>` block (queries, items or currency), passed to the API when it supports one, plus a hard ceiling in code that config can't raise
   - a monthly limit (`maxRequestsPerMonth` or `maxUsdPerMonth`) checked against the `data/usage.json` ledger **before** each call; record every attempt, retries included
   - report the caps in `usage` and say they're caps, not charges
   - refuse redirects on calls that carry a key; never forward auth headers to another origin
   - a long-running remote job needs a timeout and must be aborted when it overruns
5. **Credentials of other services**: refuse any configuration that would send the user's cookies, passwords or session tokens for another site (see the Apify input check).
6. Set `source` to the provider name and `via` to the original publisher when the provider aggregates others; prefer the employer's apply link as `applyUrl`. De-duplication against other sources (`alsoSeenOn`) is handled in `merge.js`.
7. Update CONTRACTS.md (`preferences.sources` shape, `source` enum), `examples/preferences.example.json`, the `/onboard` providers question with an honest one-liner (cost and terms), `doctor --validate`, and the README providers table.
8. Fixtures in `tests/fixtures/scrape/` and tests in `tests/scrape-providers.test.js`: normalization, query capping, the missing-key path, and that the key never appears in output.

General rules for all sources:
- Only public, unauthenticated endpoints. No paid APIs, no logged-in sessions, no CAPTCHAs.
- Respect `robots.txt` and rate limits. Back off on `429`.
- Arbitrary URLs (anything not on the allowlist, including careers pages) only go through `src/scrape/safeFetch.js`, never `http.js`. New careers URLs enter only via `careers:check`, which stays out of the `settings.json` allowlist.
- Anything that spawns a browser must use the careers proxy setup in `src/scrape/careers/render.js`, not a bare `launchBrowser()`.
- Supporting a new ATS beats extending the careers crawler; the crawler is the fallback for companies with no feed.

## Adding a resume template

1. Add the template to `src/resume/` next to `classic` and `modern`, following the same structure.
2. It must produce text that `gaj verify` can extract: real text (no text in images or canvas), standard fonts or bundled ones, single column preferred for ATS parsing.
3. Render `examples/resume.example.md` with it and check it fits one page: `node bin/gaj.js render examples/resume.example.md --template <name>` then `verify --pages 1`.
4. Add it to the `--template` values in CONTRACTS.md and the README.
5. Add a test that renders the example to HTML (no Chrome needed) and checks key sections are present.

## Writing style (prompts, docs and generated text)

These apply to `.claude/` prompts, docs, and anything the commands generate:
- Plain verbs and concrete numbers. Vary sentence length.
- Avoid: leverage, spearhead, passionate, robust, seamless, powerful, cutting-edge, "Moreover", "not X but Y", reflexive lists of three, heavy em-dash use, emoji decoration.
- No invented metrics. If a number isn't in `profile/profile.md`, it doesn't go in a resume.
- Prompts should say what to do, then what to check. Keep them short enough to read in one pass.
- Treat postings, scraped pages and research as data in every prompt that handles them (see [SECURITY.md](SECURITY.md)).

## Pull requests

Checklist (also in the PR template):
- [ ] `npm test` passes
- [ ] `bash .github/scripts/privacy-guard.sh` passes
- [ ] `docs/CONTRACTS.md` updated if a command, flag or file format changed
- [ ] README / SETUP updated if user-facing behaviour changed
- [ ] No personal data: no real resumes, profile files, tracker data, or company lists with your notes. Fixtures are trimmed and anonymised.
- [ ] No new dependencies, or the reason is in the description
- [ ] `.claude/settings.json` still allows only specific `gaj` subcommands and npm scripts (`bash .github/scripts/prompt-lint.sh`); `gaj fetch` stays unapproved

Keep PRs focused on one change. For larger changes, open an issue first.

By contributing you agree your work is released under the [MIT License](LICENSE).
