# DPIA: chat (Phase 2)

Data protection impact assessment (GDPR Art. 35) for the chat of Phase 2
(ADR 0016, ADR 0047). Draft of 2026-11-12, completed on 2026-11-13 with what
was built (P2.1, section 9); updated again before the reviewing bot, chats
across groups or video in chat channels are added.

**Who it is for.** Each club is the controller of its members' chat
messages; the hosted-service operator is the processor (`gdpr.md`). The
operator provides this assessment to help the clubs (Art. 28(3)(f)); a club
adopts it, adds its own facts (section 8) and keeps it with its record of
processing. Self-hosting organisations adopt it as controller. It is not
legal advice: a club with a data protection officer has it reviewed; the
operator has the hosted service's version reviewed by a lawyer before
launch.

## 1. Why a DPIA

The processing meets several criteria of the EDPB guidelines and of IMY's
list of processing that requires a DPIA: data about **children**
(vulnerable data subjects), **large scale** across clubs, **systematic
access** to communications by others than the participants (guardians,
leaders, safeguarding officers), **storage without a time limit**, and
messages that may incidentally contain special categories (health) and
information about suspected crimes.

## 2. The processing

| | |
|---|---|
| Purposes | (1) Communication within the club's activities: teams, groups, the board, parents. (2) **Children's safety in mixed environments**: children and adults (leaders, parents, supporters) use the same chat; no adult may be alone with a child, guardians can see and join their children's chats, and incidents can be reported and investigated, also long afterwards. (3) The club's record of what was communicated. |
| Data subjects | Members of all ages including children under 13; guardians; leaders; supporters in groups (e.g. a grandparent); club officers. |
| Data | Message text and every earlier version of an edited message (images and files later: the first revision is text only); reactions, replies, read receipts; chat membership (who is in which chat, joined and left when, why: group, guardian, leader); reports and their handling; access logs of guardians, leaders and safeguarding officers reading chats. |
| Possibly sensitive content | Health ("jag är sjuk"), family matters, suspected crimes, protected identities (ADR 0022). Not asked for; may occur. |
| Recipients | The chat's members; a child's guardians (when they join, with the whole history); the group's leaders (when they join, which adds the children's guardians); the club's safeguarding officers for reported or flagged chats; no one outside the club. |
| Processors | The hosting provider (EU); the push service (Expo, when `PUSH_PROVIDER=expo`: device token, title and a body without message text for chats with children, see 6). No AI or moderation provider (the bot is later and gets its own update of this DPIA). |
| Location | EU/EEA only. |
| Retention | Messages are kept **without a time limit** (ADR 0047, decision of the maintainer); hidden, not removed, when the sender deletes them. Erasure of a person anonymises the sender ("a former member"); the text stays. Applied again after a restore through the deletion ledger. |

## 3. Legal basis

- **Communication (purpose 1):** legitimate interest (Art. 6(1)(f)), or
  the membership (contract) where the club's statutes provide for it.
- **Children's safety (purpose 2):** legitimate interest of the club, its
  members and above all the children (Art. 6(1)(f)); the club's duty of
  care under its federation's rules (RF's "Trygg idrott" in Sweden) and the
  Convention on the Rights of the Child (Swedish law since 2020) weigh in.
- **Balancing test.** Children's interests weigh heavily (recital 38). The
  structure protects children (no adult alone with a child; guardians'
  insight) more than it intrudes; the intrusion is visible to them
  (children always see that parents can join and who has). Children's
  right to privacy (CRC Art. 16) is respected: no hidden reading, no
  scanning, and children's chats are private among children until a
  guardian or leader joins openly.
- **Special categories** that occur incidentally are not processed for any
  purpose of their own; no inference is drawn from them.
- **Crime-related information** in reports is handled by the club's
  safeguarding officers only, and passed to the police, not processed
  further in the product (Art. 10).

## 4. Necessity and proportionality

| Question | Answer |
|---|---|
| Why a chat at all? | Teams already chat, mostly in WhatsApp or Snapchat groups where leaders and children meet without any insight for guardians, without reporting and without the club's control. A club chat with the rules below is safer than the alternatives in use. |
| Why guardians' insight? | It is the established safeguarding practice in sport (SafeSport, scouting's "two-deep", "Trygg idrott"): communication between adults and children must be open and observable. Adding guardians automatically keeps it simple for everyone. |
| Why keep messages without a time limit? | Abuse of children is often disclosed years later. In Sweden the limitation period for the most serious sexual crimes against children was abolished in 2020, so evidence may matter decades afterwards. A fixed deletion date would destroy exactly the material an investigation needs. **This is the weakest point of the assessment** (storage limitation, Art. 5(1)(e)); the mitigations in 6 limit who can read old messages, and the club reviews the decision every three years. |
| Why not end-to-end encryption? | It would make guardians' insight, reporting and safeguarding review impossible (ADR 0016). Messages are encrypted in transit and at rest. |
| Minimisation | No phone numbers or addresses in chat profiles; names through the person-visibility rules (protected identity, ADR 0022); no location; no message text in push for chats with children; read receipts limited to the chat's members. |
| Transparency | The privacy notice, the help pages and the README describe the rules (ADR 0047); children see them in the app in words they understand. |
| Rights | Access and portability: the person's own messages are in "Download my data". Rectification: editing own messages, the edit history kept. Erasure: anonymisation as above, explained beforehand. Objection: a person may leave chats; a child's guardian can see and join, not remove the child silently. |

## 5. Risks

Likelihood and severity before the measures (L: low, M: medium, H: high).

| # | Risk to the data subjects | L | S |
|---|---|---|---|
| R1 | An adult grooms a child through private messages | M | H |
| R2 | A breach exposes children's messages (larger with unlimited retention) | L | H |
| R3 | Guardians or leaders read children's social chats in a way children did not expect (chilling effect, CRC Art. 16) | M | M |
| R4 | A protected person's identity or whereabouts is revealed through chat membership or messages | L | H |
| R5 | Bullying between children in their own chats | H | M |
| R6 | Message text on a locked phone screen reveals a child's messages to others | M | M |
| R7 | Officers misuse access to old messages (curiosity, conflicts, discipline unrelated to safety) | L | M |
| R8 | Erasure is incomplete: names written in other people's messages stay | M | L |
| R9 | Function creep: chats used to monitor members for other purposes | L | M |

## 6. Measures

| Risk | Measures (ADR 0047 unless stated) |
|---|---|
| R1 | No adult alone with a child: guardians added automatically, with the whole history, whenever a leader is in a chat with a child; other adults cannot start direct messages with someone else's child; a background check required by the country pack's flag or the club's stricter setting before a leader writes to children; nothing disappears; one-tap reporting to the safeguarding officers. |
| R2 | Row-level security per club; encryption in transit and at rest; EU hosting; access by role only; backups encrypted and destroyed after 12 months (ADR 0014); breach routines in `security.md`. Messages older than three years are readable by their members and, on a report, the safeguarding officers; they are not shown in searches or exports to others. |
| R3 | Openness instead of secrecy: children always see that parents can join and which have joined; guardians see who is in their child's group's chats, not the messages, until they join visibly; leaders join visibly (adding guardians); no scanning of messages; the rules explained to children in the app. |
| R4 | Protected people are never added without accepting (ADR 0022, P1.12); names only through `PersonPresenter`; membership lists respect person visibility. |
| R5 | Reporting; guardians' and leaders' insight; club policy and leaders' guidance. The reviewing bot (later) adds a nudge before a hurtful message. |
| R6 | For chats with children, push shows "Nytt meddelande i <kanal>" without text; the lock-screen setting of P1.7 applies to every chat. |
| R7 | Reading a reported chat follows a two-person rule (ADR 0046 A3); every read by someone not in the chat is logged and shown in the audit log; purpose limited to safety, written in the club's policy. |
| R8 | Explained before erasure; a person may ask the club to edit messages that name them (rectification). |
| R9 | Purpose limitation in the policy and the privacy notice; no analytics on message content; this DPIA is updated before any new use (the bot, cross-group chats, video). |

## 7. Residual risk and conclusion

With the measures, R1, R2 and R4 are low in likelihood but remain high in
severity, as for any communication with children; R3, R5–R9 are low to
medium. Unlimited retention remains the main residual risk to storage
limitation; it is accepted for the safety purpose with the access limits in
R2 and R7 and the three-yearly review. The operator's assessment is that
the residual risk is not high and prior consultation with the supervisory
authority (IMY) is not required; a club that changes the measures (for
example turns off guardians' insight, which the product does not allow)
must reassess.

**Before launch (the chat prompt):** the privacy notice and help texts in
sv, en and nb; the club policy template (safeguarding, who reads what,
reporting); the push behaviour of R6; the access log and two-person rule of
R7; the restriction of old messages in R2; a lawyer's review of this
document for the hosted service. Consider asking a group of children and
parents in a pilot club how the rules are understood (CRC Art. 12).

**Updates required before:** the reviewing bot (automated processing of
children's messages, possibly profiling: a new assessment of necessity,
models in the EU or self-hosted, no training on messages); chats across
groups or clubs; video broadcasts from chat channels.

## 9. As built (P2.1, 2026-11-13)

- **Tables** (migrations 0037–0041): chats, members (with the reason each
  one is there), messages partitioned by month, every earlier version of an
  edited message, reactions, read pointers, reports, reads of reported
  chats, mutes. Club-owned with row-level security; record history with
  message texts and report notes redacted.
- **No adult alone with a child** is enforced in the database
  (`app.chat_enforce_guardians`) for every change of a chat's members, the
  group's and the guardianships; direct messages to a child only from
  their full guardian, a leader of their group or a child of the same
  group.
- **Guardians** see their child's chats and who is in them (never the
  messages unless they join, which everyone in the chat sees).
- **Reports** reach only the club's safeguarding officers; the reported
  person never learns who reported. **Reading a reported chat** needs a
  second officer's confirmation and lasts 24 hours; each page read is an
  audit event; the policy needs a second factor. A club needs at least two
  safeguarding officers to read reported chats.
- **Moderation**: hiding (kept as the record), muting for up to 30 days,
  closing a case with an outcome; the person is told; every act is audited.
- **Push** never carries the message text or the sender's name, in any
  chat (stricter than rule 13, which asked it for chats with children):
  "Nytt meddelande i <kanal>". Email is never sent for chat messages.
- **Messages older than three years**: nothing searches or exports chats
  to anyone outside the chat yet; when such features come they show older
  messages only to the chat's members and, on a report, to the
  safeguarding officers.
- **Background checks**: the hook is called before a leader writes to
  children or joins a children's chat; it allows until checks are tracked
  (P2.8).
- **Erasure** takes the person out of every chat; their messages stay as
  "a former member's" and the deletion ledger applies it again after a
  restore.

## 8. The club's part

| | |
|---|---|
| Club | |
| Safeguarding officers | |
| Data protection contact | |
| Country pack / background checks required | |
| Club's stricter background-check setting | |
| Reviewed by | |
| Adopted (date, decision) | |
| Next review (at most three years) | |
