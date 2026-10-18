# Candidate profile: Jane Doe

<!--
Facts store and single source of truth for every resume, cover note, message
and interview answer. Copy to profile/profile.md (or let /onboard write it).
Rules:
- Only true facts. Anything guessed carries "(inferred — confirm)".
- Metrics carry "(confirmed YYYY-MM-DD)" once the candidate confirms them.
- New facts confirmed in a session are added here in the same turn, and logged
  at the bottom.
Everything below is fictional example content.
-->

## Identity & contact

- Name: Jane Doe
- Location: Bengaluru, India
- Email: jane@example.com
- Phone: +91 90000 00000
- LinkedIn: linkedin.com/in/janedoe
- GitHub: github.com/janedoe
- Portfolio: janedoe.dev
- Pronouns (optional): she/her

## Targets

| Track id | Track | Target titles | Seniority | Why this track |
|---|---|---|---|---|
| fe | Frontend Engineer | Frontend Engineer, UI Engineer | mid, senior | Most of my shipped work; want to go deeper on web performance and testing |
| fde | Forward Deployed Engineer | Forward Deployed Engineer, Solutions Engineer | mid | Enjoy customer-facing integration work |

- Total experience: 4 years (Jul 2022 - present)
- Next-role goals: own a product surface end to end; work closer to customers

## Work authorization

- Authorized to work in: India (citizen)
- Needs sponsorship elsewhere: yes
- Open to relocation: no
- Notice period: 60 days (buyout possible: yes, up to 30 days)
- Earliest start: <YYYY-MM-DD or "after notice">

## Experience

### Senior Frontend Engineer | Northwind Logistics (Series C, freight software)
Jul 2024 - Present | Bengaluru (hybrid)

- Scope: one of 6 frontend engineers; owned the shipment-tracking web app.
- Built an offline-first React app for warehouse staff, used by about 2,000 people daily. (confirmed 2026-01-10)
- Cut dashboard initial load from 4.1s to 1.6s (LCP, p75) by code-splitting and moving to server rendering. (confirmed 2026-01-10)
- Added end-to-end tests to the release pipeline with 1 other engineer; escaped bugs per release fell (inferred — confirm: is there a number?)
- Tools: React, TypeScript, Next.js, Redux Toolkit, IndexedDB, Vitest, Playwright

### Frontend Engineer | Bright Labs (seed-stage SaaS)
Jul 2022 - Jun 2024 | Remote

- Shipped the onboarding flow; signup completion rose from 38% to 52% in 6 weeks after launch. (confirmed 2026-01-10)
- Built integrations for 5 enterprise customers, working directly with their engineers. (confirmed 2026-01-10)
- Tools: React, JavaScript, Node.js, PostgreSQL

## Projects

### Tiny Charts | github.com/janedoe/tiny-charts
- Open-source SVG chart library, 2 KB gzipped; 400 GitHub stars. (confirmed 2026-01-10)
- Role: sole author.

## Skills

| Skill | Proficiency (expert / working / familiar) | Evidence (where used, how long) |
|---|---|---|
| React | expert | 4 yrs, both jobs, offline-first app |
| TypeScript | expert | 2.5 yrs at Northwind |
| Next.js | working | Northwind tracking page SSR |
| Node.js | working | Bright Labs integrations |
| GraphQL | familiar | side project only |
| Accessibility (WCAG 2.1) | working | fixed audit findings on the tracking app |

## Education

### B.Tech, Computer Science | Example Institute of Technology
2018 - 2022 | CGPA 8.4/10

## Certifications

- <Name> | <Issuer> | <Year> (or "none")

## Stories (STAR bank)

<!-- 4-6 stories covering: ownership, impact, conflict, failure, ambiguity, customer. -->

### 1. Dashboard performance rescue
- Competencies: ownership, performance, impact
- Situation: Customers complained the dashboard took over 4s to load on mid-range phones.
- Task: I owned the fix as the engineer on the shipment-tracking page.
- Action: Profiled with Lighthouse and the React profiler, code-split by route, moved the first view to server rendering, cut a 300 KB date library.
- Result: p75 LCP 4.1s to 1.6s; support tickets about slowness dropped (no exact number).
- Use for: "a technical challenge", "a time you improved performance", "biggest impact"

### 2. Enterprise integration under deadline
- Competencies: customer, ambiguity, communication
- Situation: <...>
- Task: <...>
- Action: <...>
- Result: <...>
- Use for: <...>

### 3. <Title>
- Competencies: conflict / disagreement
- Situation: <...>
- Task: <...>
- Action: <...>
- Result: <...>
- Use for: <...>

### 4. <Title>
- Competencies: failure / learning
- Situation: <...>
- Task: <...>
- Action: <...>
- Result: <...>
- Use for: <...>

### 5. <Title> (optional)

### 6. <Title> (optional)

## Behavioral / working style

- Works best with: clear ownership, small teams, fast feedback
- Communication: prefers written specs; comfortable presenting to customers
- Feedback received (real quotes from reviews, if any): <...>

## Motivations

- Want more of: product ownership, performance work, talking to users
- Want less of: pure ticket execution, long release cycles
- Company preferences: early to growth stage, product companies

## Deal-breakers

- No services/outsourcing companies
- No 6-day work weeks

## Languages

- English: professional
- Hindi: native

## Facts confirmed in sessions

<!-- Append one line per fact: date · fact · where it came from. Newest last. -->
- 2026-01-10 · Northwind LCP 4.1s → 1.6s (p75) · confirmed during /onboard
- 2026-01-10 · Bright Labs signup completion 38% → 52% within 6 weeks · confirmed during /onboard
