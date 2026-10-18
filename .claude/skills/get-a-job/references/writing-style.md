# Writing style

Applies to every text a human will read: resume summary and bullets, cover
notes, DMs, emails, form answers, interview answers, follow-ups. Goal: sounds
like a competent person talking plainly to a hiring manager.

## 1. Cut these

**Puffery and self-praise.** passionate, highly motivated, results-driven,
dynamic, proven track record, dedicated, hard-working, detail-oriented (as
filler), self-starter, team player, go-getter, committed to excellence, rockstar,
ninja, world-class.

**AI vocabulary.** leverage, spearhead, orchestrate, empower, streamline,
foster, elevate, unlock, harness, robust, seamless, cutting-edge, innovative,
transformative, pivotal, crucial, testament, landscape, tapestry, delve,
underscore, showcase, boast, synergy, holistic, paradigm, realm, navigate (the
complexities), ever-evolving, game-changer, best-in-class, "drive" used more
than once per document.

**Rule of three.** Stacked triplets ("fast, reliable, and scalable"; "design,
build, and ship") as a habit. Use one or two items, or a real sentence. One
triplet per document at most, only when there really are three things.

**Negative parallelism.** "Not just X, but Y", "It's not X, it's Y", "less
about X, more about Y". Say Y.

**Em-dash overuse.** At most one em dash (—) per document; none in resume
bullets. Use a comma, a full stop, or parentheses.

**Transition tics** at sentence start: Additionally, Moreover, Furthermore,
Notably, Consequently, Importantly, Ultimately, In today's.

**Formal filler.** "I hope this message finds you well", "I am writing to
express my interest", "Thank you for your time and consideration", "I believe I
would be a great fit", "hit the ground running", "I am excited to apply".

**Formatting overkill.** Bold on every other phrase, emoji, headings inside a
short message, bullet lists in a 3-sentence DM.

**Hedging and apology.** "I think I could maybe contribute", "although I don't
have much experience". State what is true; frame gaps honestly and briefly.

## 2. Do this instead

- Plain verbs: built, shipped, wrote, ran, cut, fixed, owned, led (only if they
  led), migrated, designed, reduced, grew, debugged, launched, rewrote.
- A number or a specific detail beats an adjective. "Cut bundle size from 1.2 MB
  to 480 KB" beats "significantly improved performance".
- Vary sentence length. Some short. Some longer with a clause. Do not start
  three bullets in a row with the same verb or structure.
- First person, active voice in prose ("I built"); resume bullets drop the "I".
- Match the posting's terms where they are true for the candidate (see
  `resume-rules.md`), never as decoration.

## 3. Honesty (non-negotiable)

- **No invented metrics.** Only numbers present in `profile/profile.md` or
  `profile/resume.md`. No number available → keep it qualitative or ask the
  user (and write back the answer).
- **Honest attribution.** Team outcomes read as team outcomes: "part of a
  4-person team that...", "with the platform team". Do not convert "contributed
  to" into "led".
- **No seniority overclaim.** Do not inflate titles, years, team sizes, or
  ownership. "Mentored 2 interns" does not become "managed a team".
- **No tool overclaim.** A tool used once in a side project is not "expert".
  Use the proficiency recorded in the profile Skills table.

## 4. Final check (run before showing anything as final)

1. Run the banned-word grep below on the file(s). Rewrite every hit, unless it
   is inside a proper noun or quoted posting text.
2. Count em dashes (`—`). Resume: 0. Other prose: ≤ 1.
3. Scan for triplets and "not X but Y".
4. Read it as a sharp recruiter: would they guess this was AI-written? Any line
   that sounds like a template or a brochure gets rewritten plainly.

## 5. Banned-word list (machine-checkable)

Use with the Grep tool, case-insensitive (`-i: true`), on the generated file:

```regex
\b(leverag(e|ed|es|ing)|spearhead(ed|s|ing)?|orchestrat(e|ed|es|ing)|empower(ed|s|ing)?|streamlin(e|ed|es|ing)|foster(ed|s|ing)?|elevat(e|ed|es|ing)|unlock(ed|s|ing)?|harness(ed|es|ing)?|robust|seamless(ly)?|cutting-edge|innovative|transformative|pivotal|crucial|testament|landscape|tapestry|delv(e|ed|es|ing)|underscor(e|ed|es|ing)|showcas(e|ed|es|ing)|boast(s|ed|ing)?|synerg(y|ies)|holistic|paradigm|realm|ever-evolving|game-changer|best-in-class|world-class|passionate|highly motivated|results-driven|proven track record|self-starter|go-getter|team player|detail-oriented|hit the ground running|moreover|furthermore|additionally|notably|i hope this (message|email) finds you well|i am writing to express|thank you for your time and consideration|not just|it's not)\b
```

Also grep for `—` (em dash) and count matches.

Exceptions: a hit inside a company or product name, a quoted job title, or the
verbatim `job_posting.md` is fine. Everything the candidate "says" must be clean.
