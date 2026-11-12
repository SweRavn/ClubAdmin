# 0049 — Documents, meetings with minutes, and signing in the app

**Status:** Accepted (decided 2026-11-12, before the Phase 2 document
prompts; builds on ADR 0011 and ADR 0037)

**Context.** Clubs keep files (forms, match schedules, policies) and
governing documents (statutes, minutes of the annual meeting and the
board). ADR 0037 decided how adopted documents set club settings; ADR 0011
how files are stored (S3-compatible storage, pre-signed URLs, ClamAV before
a file is visible). Boards and committees meet, need a notice, an agenda and
minutes that are approved ("justerade"). Electronic signatures come in three
levels under eIDAS (EU 910/2014, amended by 2024/1183): simple (SES),
advanced (AdES, e.g. BankID, Freja eID+) and qualified (QES). Swedish
non-profit associations (ideella föreningar) have no statute prescribing the
form of minutes or their approval: the club's statutes and practice decide;
the advanced-signature requirements for board minutes concern limited
companies and economic associations. EU Digital Identity Wallets are to
offer free qualified signatures for non-professional use.

**Decision.**

1. **Two kinds of documents on one base, files first.**
   - **A. File archive:** files in folders, at club or group level. Group
     leaders create their group's folders themselves. A new version of a
     file keeps the earlier ones (history, downloadable).
   - **B. Governing documents (ADR 0037):** series (statutes, annual
     meeting minutes, board minutes, policies, the club's own), written in
     the app in Markdown with marked settings, draft → adopted (date,
     meeting, effective date) → superseded; an adopted version is locked
     (changes mean adopting a new one); a scanned signed PDF may be
     attached.
2. **Who sees what: an audience list** on a folder or document, as events
   have audiences. Each entry is one of: the whole club (members **and their
   guardians**), a group (optionally only some roles in it, e.g. the
   leaders), a club role, or **public** (both kinds; any number of public
   documents, shown on the club's public pages when they come, Phase 3).
   A club that wants an "access group" (e.g. the office) makes a group of
   kind `other` without activities: there is no separate mechanism.
3. **Boards and committees are ordinary groups**, as little special as
   possible (decision 1–2): kinds `board` and `committee` already exist;
   members are added by hand, adjunct members and others included; no
   membership derived from club roles and no required group. Calendar,
   notices, answers, channels and documents work as in every group.
   Automatic additions (e.g. from the board roles) may come later as bots or
   scripts on top. The annual meeting is not a group: a club-wide meeting.
4. **Meetings with structured minutes.**
   - A meeting is an activity of kind `meeting` in the group (or the club
     for the annual meeting): calendar, notice (call-up), answers and car
     pools come with it; the agenda and its papers belong to the meeting.
   - **Agenda items** are rows (number, title, presenter, papers, time),
     from a template (the country pack's or the club's: "Mötets öppnande",
     "Val av justerare", …). During the meeting each item has its own
     editable Markdown field; **decisions** are checked per item with their
     text (which may mark settings, ADR 0037); action items get an assignee
     and a date.
   - **The minutes are assembled** from the items into one Markdown
     document (one § per item) in the series of the group (e.g. board
     minutes). Markdown stays the format of every text; the structure
     (items, decisions, actions) lives in tables around it.
5. **Signing in the app (simple level, strong evidence).** Approving
   ("justera") and signing are done in ClubAdmin: a recent login with a
   second factor, the SHA-256 hash of exactly the version signed, a
   timestamp and an audit event; the signed version is locked and gets a
   signature page (PDF) whose hash shows any later change. Each signature
   records its level (`simple` now). **External providers are plugins**
   behind a `SignatureProvider` interface (as payment providers), for
   BankID, Freja and the EU wallet later, recording their level (AdES,
   QES). For now a club cannot require a level.
6. **Storage limits** at two levels: the operator sets a limit per
   installation or plan (entitlements, ADR 0012/P0.12); the club sets its
   own within it and may divide it per group.
7. **Files**: type allow list, size limits, ClamAV before a file is
   visible, served from a separate domain as attachments (`security.md`).
   The same storage serves chat attachments later (ADR 0047, first revision
   text only).
8. **Kept until deleted**; an adopted governing document cannot be deleted,
   only archived (the club's record). Erasing a person does not rewrite
   adopted documents or signed minutes (stated in the privacy notice);
   mentions written with `@` render through `PersonPresenter` (protected
   identity); the editor warns about free-text names.
9. **Aggregation**: a "Dokument" tab per group and for the club, "Mina
   dokument" with what is new since the last visit, push when new minutes
   or statutes are adopted.
10. **Export**: all documents and files are part of the club's full export
    (open data).

**Consequences.** Documents, meetings and signing reuse groups, activities,
notices and audiences instead of new structures; boards stay flexible. In-app
signatures are simple signatures: enough for internal approval of minutes
in an association unless its statutes or a counterpart (a bank, a grant
giver) require more, which the plugins will cover; a lawyer should confirm
this before the hosted service relies on it. Order: the file archive and
audiences; then governing documents (ADR 0037); then meetings, agendas,
minutes and signing.
