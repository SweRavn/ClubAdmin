# 0047 — Child safety in chat: no adult alone with a child, open to guardians

**Status:** Accepted (decided 2026-11-12, before the Phase 2 chat prompt; the bot later)

**Context.** Chat (ADR 0016) is the product's most important new feature in
Phase 2, and children use it. Established safeguarding practice in sport is
that no adult is ever alone with a child, also digitally: the US SafeSport
Code requires a leader's communication with a minor to be open and
observable (a parent or a second adult included); Scouting's "two-deep
leadership" says the same; RF's "Trygg idrott" and the Convention on the
Rights of the Child (Swedish law since 2020) set the frame in Sweden. Team
apps (Spond, SportsEngine) add guardians automatically when a coach writes to
a child, so nobody has to approve anything. Detection (grooming and bullying
classifiers, hash matching of known abuse images, nudity detection) is used
by large platforms but has false positives, especially in Swedish, and
scanning children's messages needs a data protection impact assessment
(DPIA) and proportionality. Children also need chats of their own to
socialise.

**Decision.** Structure first, openness to guardians second, a reviewing bot
as a complement. Nothing here needs anyone to approve anything by hand.

1. **No adult alone with a child.** Whenever a leader is in a chat with a
   child (a direct message, or a leader joining a children's chat), the
   guardians of the children in it are added automatically, with the whole
   history. Only guardians, not other leaders (decision 1). Everyone in the
   chat sees who is in it.
2. **Other adults** (other parents, supporters such as a grandparent in the
   group to follow its matches) cannot start a direct message with someone
   else's child. Guardians always can with their own children.
3. **Children's own chats.** Children of every age, also under 13, may have
   direct messages and chats with each other: they have an important social
   function (decision 2). For now between children of the same group (groups
   are mostly by age); chats between children of different groups come later
   (decision 3), so the model must not tie a chat to one group (below).
   Children create channels themselves (the participant role holds
   `group.channels.create`); a channel a child creates is open to
   guardians and the group's leaders as in rule 4, like any chat with
   children.
4. **Open to guardians, visibly.**
   - A guardian sees which chats their child is in and may join any of them,
     with the whole history; guardians are not added automatically (except
     under rule 1).
   - The chat always shows the children that their parents can join, and
     which parents have joined.
   - Guardians of a group's children see who is in the group's chats that
     have children in them (membership, not messages), also chats they are
     not in: child A's parents see that child B's parents joined.
   - **Closed channels** (only the members the creator adds; others of the
     group neither see nor join them) may be created, e.g. for the leaders.
     These rules still apply to a closed channel with children in it: their
     guardians see it and may join, and a leader in it adds them. A closed
     channel without children is hidden from everyone else.
   - The group's leaders may join the children's chats of their group; rule 1
     then adds the children's guardians.
5. **Nothing disappears.** Messages are kept without a time limit, in
   every chat (decision 4, 2026-11-12): no disappearing messages and no
   automatic deletion; a message its sender deletes is hidden, not removed.
   Erasing a person (P1.8b, ADR 0041) anonymises their messages (decision
   6): the sender becomes "a former member", the text stays. It is part of
   `app.erase_person`, so the deletion ledger (`privacy.deletion_ledger`,
   ADR 0030) applies it again after a restore, as for everything else the
   erasure touches; no log of its own. Names the text itself mentions are
   not rewritten.
6. **Background checks for writing to children.** Every country pack has
   the requirement as a flag (`backgroundCheckForChildren`: required or
   not); the rule always exists. A club may require more than its pack
   (require it where the pack does not), never less (the settings registry's
   limits, ADR 0041). Where required, a leader writes to children and joins
   children's chats only with a valid check (the background-check tracking
   of Phase 2).
7. **Reporting.** One tap for children and guardians; the reported person
   does not see who reported. Reports go to the club's safeguarding officers
   (the `safeguarding_officer` template role, a permission in the catalogue).
8. **A reviewing bot that alerts, never punishes** (later, decision 5: not
   part of the first chat prompts).
   - Rule signals: moving the talk elsewhere (Snapchat, phone numbers,
     links), secrecy ("don't tell your parents"), gifts, messages late at
     night.
   - Classifiers for grooming, bullying and self-harm; hash matching of
     uploaded images against known abuse material; nudity detection on
     images sent to or by children.
   - A nudge before sending ("Vill du verkligen skicka det här?") when a
     child is about to send something hurtful.
   - Alerts go to the safeguarding officers; reading a flagged message
     follows a two-person rule (as for administrators, ADR 0046 A3) and every
     read is logged. Severe signals hold a message before delivery.
   - Models run in the EU or self-hosted; children's messages are never sent
     to third parties for training. Everyone is told the bot exists. A DPIA
     is written before it is switched on. People decide, not the bot.
9. **Order of delivery.** First the structure (rules 1–7) and reporting;
   the bot (rule signals, then classifiers and image checks) comes later as
   work of its own. Until then images in chats with children are not
   scanned.

**Architecture consequence (decision 3).** A chat is not owned by one group.
Who is in a chat is its own membership list (people), with the context that
explains why (a group, several groups, or none, as for direct messages);
the safety rules above are evaluated from the members' ages, guardianships
and roles, not from the chat's group. Chats between children of different
groups, or groups of different clubs, can then be added later without
changing the model.

**Documentation.** The chat prompt describes these rules clearly in the
project README (for clubs, parents and contributors), in the help pages in
sv, en and nb, and in the privacy notice; children see them in the app in
words they understand.

**Consequences.** Leaders' direct messages to children always have parents
reading along; children's chats are private among children until a parent or
leader joins, which everyone sees. Keeping messages without a time limit
needs a DPIA and a stated purpose (safeguarding, the club's record) under
GDPR's storage limitation: the draft is [`dpia-chat.md`](../dpia-chat.md),
completed by the chat prompt. The bot's languages
and models are decided when it is built.

## As implemented (P2.1 part A, 2026-11-13)

- **The guardian rule** is a SQL function (`app.chat_enforce_guardians`,
  migration 0037) the chat service runs after every change to a chat's
  members and the worker after group and guardianship changes. "Adults who
  count" are adult members who are not a full guardian (parent, legal
  guardian) of a child in the chat, **or** who lead a group a child in the
  chat is in: a coach who is also a parent still brings the other
  children's guardians in; a parent who joins their child's chat does not.
  Guardians the rule added (`guardian_auto`) cannot leave or be removed
  while it holds (they can turn push off), and leave by themselves when it
  no longer holds (the leader left, the child turned 18: the worker rechecks
  daily). A system message tells everyone which guardians were added.
- **Children** are members below the club's country pack's adult age with a
  known birth date (`chats.has_children` kept by the rule). People without a
  birth date count as adults.
- **Direct messages** (`app.chat_direct_refusal`): adults with adults; to a
  child only their full guardian, a leader of a group the child is in, or a
  child of one of the child's groups; a child to children of their groups,
  their guardians and their groups' leaders. Anything else is
  `chat_child_protected`.
- **Whom a channel may hold** (`app.chat_unaddable`): people of its groups
  or full guardians of them ("the team's parents"); for club channels anyone
  related to the club. A child adds only children who share one of the
  channel's groups with them.
- **Guardians' insight** (rule 6): the `chat.read` policy lets a full
  guardian of a member see the chat and who is in it (also closed ones), not
  the messages; joining (`guardian_joined`) shows them to everyone. A
  guardian acting on behalf of the child never reads or writes the child's
  chats: the clients never send `X-On-Behalf-Of` on chat and real-time
  paths (`onBehalfApplies`), so "viewing as" a ward still shows the
  guardian's own chats, and the API refuses chat on behalf of anyone.
- **A group's default channel** is created when the group's page is first
  opened. A group nobody used can still be deleted: its channel goes with
  it unless someone wrote in it (migration 0038); otherwise the group is
  archived, as any group in use.
- **The app** keeps chats cache first: "Mina kanaler", a chat's members
  and its messages show from the encrypted cache at once. The real-time
  connection is open only while a chat screen is shown and the app is in
  the foreground; its events (IDs only) mark the cached data stale.
  Messages go through the outbox with a UUIDv7 chosen on the phone, so they
  wait for coverage and a resend never posts twice.
- **Leaders** of a chat's groups see and may join children's chats of their
  group (`leader_joined`); the guardian rule then adds the guardians.
- **Protected people** are offered a chat (`offered`), never added, also as
  guardians the rule needs; declining is final (not offered again).
- **Nothing disappears:** deleting hides; every earlier text is in
  `chat_message_versions`; erasure takes the person out of every chat and
  their messages stay as "a former member's".
- Reporting, safeguarding cases, moderation by safeguarding officers, the
  background-check hook and the three-year limit on old messages come with
  part B; push per channel with part C.
