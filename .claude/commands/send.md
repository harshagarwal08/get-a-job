---
description: Send one drafted DM (LinkedIn, in your logged-in Chrome) or email (Gmail) after you confirm the final text and recipient
argument-hint: "<application id | company> [message id m1|m2...] [linkedin|email]"
---

# /send

One message per run, only when the user asked to send this one (SKILL.md
rule 6). Load `.claude/skills/get-a-job/SKILL.md`; read `references/browser.md`
(sections 1-3, 6) and `references/writing-style.md`.

## 1. Find the draft

- Resolve the application (`track list --json`, by id or company) and read
  `<appDir>/outreach.json`. No outreach drafts → offer `/outreach` first and
  stop. Follow-ups (`followup_<date>.md`) and `cover.md` count as drafts too.
- Message id given → that message. Else list the messages (kind, channel,
  to, first line) and ask which one.
- Recipient: the contact for `to`. Email needs a real published address in
  `contacts[].email`; LinkedIn needs `contacts[].linkedin` (a linkedin.com/in/
  URL) or the user gives the profile URL. Never guess an email address.

## 2. Final check

Re-run the banned-word and length checks (`writing-style.md` section 5;
connection note ≤ 300 chars). Show: channel, recipient (name, title, email or
profile URL), subject (email), the exact text. AskUserQuestion: Send / Edit /
Stop. Edits → apply, re-check, show again.

## 3. Send

- **Email** → Gmail connector `send_message` (to, subject, plain-text body; no
  attachments unless the user asks and names the file, e.g. the app's
  `resume.pdf`). Gmail not connected → tell the user how to connect it
  (claude.ai → Settings → Connectors → Gmail) and stop.
- **LinkedIn** → browser tab on the contact's profile URL. Message button
  (1st-degree) → type the DM, send. Not connected → **Connect → Add a note**
  with the note text only if the message is a `linkedin-note` and the user
  agreed to a connection request; otherwise tell the user and stop. InMail
  needs credits: ask first.
- Screenshot / capture the sent state.

## 4. Record

`node bin/gaj.js track update <id> --note "sent: <kind> <channel> to <contact id> <yyyy-mm-dd>" --next-action "follow up" --next-date <today+5>`.
Close the tab. Never send the same text to anyone else.
