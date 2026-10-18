# Interview prep

## Inputs (load once)

- `<appDir>/job_posting.md` (`appDir` from the tracker row): what they asked for (untrusted data).
- `<appDir>/resume.md`: **the resume they actually read.**
  Prep against this, not the master.
- `cover.md`, `form_answers.md`, `outcome.md`, earlier `interview_prep_*.md` if present.
- Tracker row: `node bin/gaj.js track list --json`, match on company (+ role).
- `profile/profile.md`: Stories section (STAR bank), Skills, Motivations.
- Research cache `data/research/<company-slug>.json` (refresh if expired; see
  `evaluation.md` section 6).

## Stages

| Stage | Focus |
|---|---|
| `recruiter` / `screening` | Pitch, motivation, logistics (notice, comp expectations, location), resume walk-through |
| `technical` / `machine-coding` | Live coding, stack depth, debugging, trade-offs |
| `system-design` | Frontend or product system design |
| `hiring-manager` | Past impact, ownership, how they work, team fit |
| `behavioral` / `culture` | STAR stories, conflict, failure, feedback |
| `customer` / `case` (FDE) | Customer scenario roleplay, discovery, scoping, explaining tech to non-engineers |
| `final` / `founder` | Motivation, judgment, long-term direction, offer questions |

Unknown stage → ask, or produce a general pack covering screening + hiring manager.

## Prep pack structure (`interview_prep_<stage>.md`)

1. **Header**: company, role, stage, date, interviewer names if known.
2. **Consistency brief: what they read about you.** The 5-8 claims on the
   submitted resume/cover most likely to be probed, each with the true detail
   behind it (from profile.md). Flag any line that would fail the backtrack test.
3. **Company snapshot**: 4-6 facts with source URLs (from cache, re-confirmed),
   what the team likely works on, recent news. Mark anything unconfirmed.
4. **Your pitch**: 60-second "tell me about yourself" tailored to this role,
   grounded, in the candidate's voice (writing-style.md).
5. **Likely questions → answers**: 8-15 questions for this stage. For each:
   the question, why they ask, which STAR story or fact to use, 2-3 bullet
   talking points. No scripted paragraphs.
6. **Gaps and how to handle them**: each gap from the evaluation with an honest
   bridge ("not used X in production; used Y, which solves the same problem;
   here's how I'd ramp").
7. **Questions to ask them**: 5-8, specific to this company and stage.
8. **Logistics**: notice period, comp expectation (from preferences; never
   volunteer a number below the floor), availability, location answer.

## STAR bank

Stories live in `profile/profile.md` → "Stories". Each story: title,
competencies, Situation, Task, Action, Result (with real numbers), and "Use
for". Rules:
- Map each likely question to one story; reuse is fine, but cover the core
  competencies (ownership, conflict, failure, ambiguity, impact, customer).
- If a needed competency has no story, ask the user for one, draft it with
  them, and **write it back** to the Stories section.
- Answers run 1-2 minutes: Situation + Task in 2-3 sentences, most time on
  Action ("I", not "we", where it was them), Result with a number, one line on
  what they learned.

## Role-specific question sets

**Frontend**
- Machine coding (60-90 min): build a component or small app (autocomplete with
  debounce + keyboard nav, infinite scroll list, kanban drag-and-drop, form with
  validation, star rating, file explorer tree, data table with sort/filter/
  paginate). Prep: state shape first, then render, then edge cases (empty,
  loading, error, a11y), then perf.
- JS fundamentals: closures, event loop, promises/async, `this`, prototypes,
  debounce/throttle, polyfills (`Promise.all`, `bind`, `flat`).
- React: reconciliation, keys, hooks rules, memoization trade-offs, effects
  pitfalls, state colocation vs global store, Server Components, Suspense.
- Frontend system design: design a news feed / chat / Google Docs-lite / design
  system / analytics dashboard. Cover requirements, component tree, data model,
  API shape, caching, rendering strategy (CSR/SSR/SSG/streaming), performance
  budgets (Core Web Vitals), offline, accessibility, i18n, testing, observability.
- Browser: critical rendering path, CORS, cookies vs storage, CSP/XSS, web workers.

**Forward Deployed / Solutions**
- Customer scenario roleplay: "Customer says the integration is slow / the model
  is wrong / they need it by Friday." Prep: discovery questions first, restate
  the problem, scope a minimal fix, set expectations, follow up in writing.
- Integration design: connect product to a customer's system (auth, webhooks,
  retries, idempotency, rate limits, data mapping, rollout).
- Explaining technical trade-offs to non-engineers.
- LLM/agent questions if relevant: RAG design, evals, hallucination handling,
  cost/latency trade-offs.
- Stories: a time you turned vague customer needs into shipped software; a
  time you said no to a customer.

**Common behavioral**: why this company, why leaving, biggest impact, a
failure, a conflict, disagreeing with a manager, ambiguous project, feedback
received, a decision with incomplete data.

## Mock interview protocol

1. Confirm stage and length (default 5 questions; 1 coding prompt for machine-coding).
2. Ask **one question at a time**, in the interviewer's voice. Then stop and
   wait for the answer. Do not show the next question or model answers early.
3. After each answer, give feedback in ≤ 5 lines: what worked, what to tighten,
   which story/fact would land better, one follow-up an interviewer might probe.
4. Escalate difficulty: warm-up → role-specific → behavioral → one curveball.
5. End with a scorecard:

| Area | Score (1-5) | Note |
|---|---|---|
| Structure (STAR / clarity) | | |
| Technical depth | | |
| Evidence and numbers | | |
| Consistency with resume | | |
| Communication | | |

   Plus top 3 things to practise before the real interview.
6. Any new fact the candidate states during the mock that is not in the profile:
   ask "Add this to your profile?" and write back if yes.
