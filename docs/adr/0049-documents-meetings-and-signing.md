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
     and a date (tasks, ADR 0052).
   - **The minutes are assembled** from the items into one Markdown
     document (one § per item) in the series of the group (e.g. board
     minutes). Markdown stays the format of every text; the structure
     (items, decisions, actions) lives in tables around it.
4b. **Documents attached to notices.** Any activity or event (a meeting's
   agenda, a match's schedule, a cup's information) can have documents
   attached to its notice (call-up). The creator picks a document already
   in ClubAdmin or uploads one from the computer; an upload is stored in
   ClubAdmin too (the group's or club's folder for notices, through the
   same scanning as every file). Notices never carry files: email, push
   and the app send links to the documents in ClubAdmin, opened after
   login. Being invited lets a person read the documents attached to that
   notice (the attachment adds the notice's recipients to the document's
   audience for as long as it is attached); the creator sees which
   documents are attached and to whom they are thereby shown.
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
   own within it and may divide it per group. Default: 100 MB per club
   (decision 2026-11-12).
7. **Files**: type allow list, size limits, ClamAV before a file is
   visible, served from a separate domain as attachments (`security.md`).
   The same storage serves chat attachments later (ADR 0047, first revision
   text only).
8. **Kept until deleted**, attachments to notices too; an uploader may set
   a deletion date on a file, after which it is deleted automatically; an adopted governing document cannot be deleted,
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

## As implemented (P2.2 part A, 2026-11-13)

- **Audiences** (`audiences`, `audience_entries`, migration 0042) are lists
  of entries: `club`, `group`, `group_roles` (role IDs of the group's
  roles), `club_role` (a club role's ID) and `public`. Roles are referred to
  by their IDs since P1.15 made them club-defined. Who an audience includes
  is decided in SQL (`app.audience_includes(audience, person)`), by the
  person's own index entries: their membership, group roles and club
  roles, and, for the club and group entries, as a guardian of someone
  included. **Guardians count when their link receives messages**
  (`receive_messages`): parents and legal guardians always, relatives and
  others when given that right. A group entry is the group's own members,
  not its child groups' (pick several groups for several teams), as group
  permissions are not inherited (P1.15 decision 13).
- **Folders** belong to the club or a group; a subfolder has its parent's
  group and inherits its audience unless it has its own (`audience_id`
  null; `app.folder_audience` walks up). A top-level folder always has one:
  by default the group, or the whole club. Folders nest at most five deep;
  names are unique among siblings.
- **Who manages:** `club.documents.manage` (club managers, secretaries)
  manages the club's folders and every group's; `group.documents.manage`
  (head coaches, assistant coaches, team managers) and owning the group
  manage the group's. The policies are `folder.*` and `document.*`; reading
  is the audience (checked by the resource loader) or managing. Acting for
  a ward reads as the ward and manages nothing.
- **Uploads** start at the folder (`POST …/folders/:folderId/uploads`, a
  new file) or the file (`POST …/documents/:documentId/versions`), not at
  one `documents/uploads` endpoint: the authorization of each is its
  folder's or file's. The link is a pre-signed PUT (15 minutes) of exactly
  the declared size and content type to
  `documents/<club_id>/<document_id>/<version_id>`; the client then
  confirms (`…/versions/:versionId/uploaded`). Types: PDF, Word, Excel,
  PowerPoint (old and new), OpenDocument, RTF, text, CSV, PNG, JPEG, GIF,
  WebP, HEIC; at most 25 MB per file.
- **Scanning** (worker, `documents:scan`): the file must be there, of its
  declared size, and start like its type (a renamed program is refused);
  then clamd (`CLAMAV_HOST`, INSTREAM). A clean version becomes the file's
  current one (the newest clean one); an infected or refused one is
  deleted from storage and never shown. Without `CLAMAV_HOST` files are
  not scanned outside production; production refuses to start without it.
  Abandoned uploads are marked failed after an hour (`documents:cleanup`).
- **Storage limit:** the club's versions (all kept versions, uploads in
  progress included) against the plan's `storage_gb` (billing on) or the
  installation's `DOCUMENTS_CLUB_LIMIT_MB` (default 100 MB); uploads take
  the club's lock, one at a time. The club's own limits and limits per
  group come with part B.
- **Downloads** are pre-signed GETs (5 minutes) on the storage's public
  endpoint with `Content-Disposition: attachment` (the UTF-8 name per RFC
  6266); downloads of files whose audience has neither the whole club nor
  public are audited (`document.downloaded`).
- **Deleting** a folder with content needs `?confirm=true`; folders and
  files keep their rows (history, audit) marked deleted, and the worker
  deletes the stored versions (`documents:delete_objects`).
- Part B adds notice attachments, "Mina dokument", the club's storage
  settings, deletion dates and public documents; part C the pages, seed
  and the budgets of the reads.
