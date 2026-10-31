# Vision

## Problem

Swedish and other European sports clubs run on volunteers. The tools they use
(SportAdmin, MyClub, laget.se) are proprietary, often slow, and lock the club's
data in. If a service shuts down, clubs lose their history and must migrate under
pressure.

## Goal

A fast, secure, open-source club management system that:

- a volunteer can learn without training,
- loads quickly on a cheap phone over mobile data,
- keeps the club in control of its data (export everything, self-host if needed),
- handles the legal and safety obligations of working with children
  (GDPR, background checks, safe communication),
- adapts to each country's rules (language, time zone, grants, background checks)
  through country packs.

## Users

| User | Typical needs |
|---|---|
| Member / player | See schedule, respond to activities, chat with team, pay fees |
| Parent / guardian | Act on behalf of children, sign up, drive car pool, get messages |
| Relative / supporter | Follow a child or team, watch streams (read-only) |
| Leader / coach | Plan trainings, take attendance, message team, share plans |
| Team manager | Team cash desk, events, logistics |
| Board member / club manager | Members, roles, documents, meetings, budget, reporting, background checks |
| Club staff | Time reporting, salary data |
| Platform operator | Runs the hosted service, billing, support (no default access to club data) |

## Principles

1. **Speed is a feature.** Responsiveness for the person using it comes
   first, and is designed for, measured and kept (see `performance.md`).
2. **The app first, the cache first.** Most people use ClubAdmin through the
   mobile app, so the app is where responsiveness matters most. The app keeps
   as much as it can on the phone and shows it at once: everything it has
   shown, and what the person will most likely open next (the coming week),
   fetched in the background. The network refreshes what is shown; it never
   stands between a tap and the screen. Writes that can wait (answers,
   attendance) are saved on the phone and sent when there is coverage.
3. **Privacy and safety by design.** Least data, least access, everything audited.
4. **One person, many contexts.** A person has one account and many memberships.
5. **Country-agnostic core, country packs at the edge.**
6. **Open data.** Full export in documented formats. No lock-in.
7. **Boring, maintainable technology.** One language, one database, few moving parts.

## Non-goals (for now)

- Full bookkeeping and payroll engines. We integrate with existing systems.
- Building our own video infrastructure. We integrate with providers.
- Federation-level competition management (fixtures, referees, tables).
