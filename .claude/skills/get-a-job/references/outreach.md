# Outreach drafts

All drafts follow `writing-style.md` and the grounding rule. **Draft first;
send or submit only per SKILL.md rule 6 (explicit per-item request).** Save each draft in
`data/applications/<slug>/` and show the path.

Every company-specific claim (product, funding, launch) must be confirmed
against a source fetched this session (`evaluation.md` section 6). No
confirmation → leave it out.

## 1. Cover note (`cover.md`)

Optional. Many startups and ATS forms ignore it; write one only when the form
has a field for it, the user asks, or a referral/hiring manager will read it.

- 150-220 words. Plain text, no headings, 3-4 short paragraphs.
- Forward-looking: what the candidate can do for this team, backed by 1-2 past
  results with numbers. Not a resume recap.
- Structure:
  1. Opening: the role and the single strongest match, in one or two sentences.
     No "I am writing to express".
  2. Why this company: one specific, confirmed reason tied to their product or
     problem.
  3. What they would work on and how, with one proof point.
  4. One honest line on the biggest gap if it matters, then a plain close.
- Address a named person if known; otherwise "Hi <Company> team,".
- Report the word count (count programmatically, section 4).

## 2. Referral DM (`referral_dm.md`)

LinkedIn, to someone at the company (find via the people-search link from
`/scrape`). Two parts:

- **Connection note**: ≤ 300 characters (LinkedIn limit). Who you are in a
  phrase, the specific role, the ask. Example shape: "Hi <name>, I'm a frontend
  engineer at <company> (React/TS, logistics). Saw the <role> opening on your
  team. Would you be open to a quick chat or a referral? Happy to send details."
- **Follow-up message** (after they accept): 80-150 words. Role title + link or
  job ID, 2 lines of fit with one number, make it easy to say yes ("I can send a
  3-line blurb you can forward"), include that blurb.
- Never imply you know them if you do not. Never message the same person twice
  without a reply.

## 3. Recruiter email (`recruiter_email.md`)

- Subject: `<Role> - <Name>, <current role/one-line hook>` (≤ 70 chars).
- Body 80-150 words: role, 2-3 lines of evidence, notice period / location if
  relevant, attached resume reference, one clear ask.
- No "I hope this finds you well".

## 4. Application form answers (`form_answers.md`)

- Draft each field the portal asks for, labelled with the exact question.
- Respect limits. **Count programmatically, never estimate**:
  `node -e "const s=require('fs').readFileSync(0,'utf8').trim();console.log(s.length+' chars, '+s.split(/\s+/).filter(Boolean).length+' words')" <<'EOF'`
  followed by the text and `EOF`. State the count next to each answer.
- For tight limits, give 2-3 variants with counts and recommend one.
- Self-intro fields: lead with strongest evidence, end tied to this employer.
- Project fields: candidate's real role on the project; do not upgrade
  ownership; note contribution vs ownership in the text.
- Logistics fields (notice, CTC, expected CTC, location): use preferences and
  profile; for expected comp give the user the floor and ask what to enter.
- Add `NOTE TO SELF` blocks (clearly marked not for pasting) for anything the
  candidate should be ready to explain.
- Nothing in a form may contradict the submitted resume.

## 5. Follow-ups (`followup_<YYYY-MM-DD>.md`)

- Only after ≥ 10 days with no update since applying (or since last contact).
- At most 2 follow-ups per application. Track count in tracker history notes
  (`followup #1 drafted <date>`).
- 50-100 words. Reference role and date applied, one line of fit (already on the
  resume, **no new claims**), a simple question ("Is the role still open?").
- Second follow-up shorter than the first, and final in tone.
- Channel: reply in the existing thread if one exists, else recruiter/hiring
  manager on LinkedIn or email.

## 6. Thank-you notes (`thankyou_<stage>.md`)

- Within 24 hours of an interview. 60-120 words.
- Thank the interviewer by name, reference one specific thing discussed, one
  line connecting it to your fit, close. No re-pitching the whole resume.
- After a rejection: optional 2-3 sentence note thanking them and asking to be
  considered for future roles.

## 7. Cold outreach, no opening (`/cold-dm`)

For startups with no matching role, usually within 2-8 weeks of a funding
round. Saved in `data/applications/<company-slug>-open-application/`.

- **Who**: one person, two at most per company (founder/CEO first; for
  product, the CPO or head of product). Never several people with the same text.
- **First line is about them**, not the candidate: a confirmed, specific fact
  (the round and what it is for, a launch, a product detail). "Congrats on the
  raise" alone is not specific.
- **Proof over claims**: one result with a number and, if the profile has one,
  a link to work they can open (prototype, teardown, case study).
- **A concrete, small offer** the candidate can deliver this month, then one
  ask: a 15-minute call, or "is there someone I should speak to".
- Say plainly there is no posted role and you are asking anyway. Never imply a
  referral, a mutual contact or prior conversation that did not happen.
- **Short and unique**: each company gets its own hook (a number, a question or
  a test you'll run for them), never a shared template. Lead with the offer, not
  your background; one proof link is enough.
- **Lengths**: connection note ≤ 220 characters; DM 40-70 words; email
  60-90 words with a subject ≤ 40 characters; follow-up 15-30 words.
- **Follow-up**: at most one, 5-7 days after, in the same thread, no new
  claims. No reply after that → stop; mark `no_response` via `/outcome`.
- Track every cold draft with `--channel cold` so response rates show up per
  channel in the tracker stats.
