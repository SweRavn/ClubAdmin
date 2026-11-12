# 0051 — Plugins for grant reporting and background checks

**Status:** Accepted (decided 2026-11-12; replaces the `GrantRules` and
`ClearanceRules` interfaces of country packs, ADR 0015)

**Context.** Research before Phase 2 (2026-11-12) showed that grant
reporting and background checks differ too much between countries, regions
and municipalities to fit fixed interfaces in country packs:

- **Grants** come in three shapes: per session and attendance (Sweden's
  LOK-stöd, Swedish municipal grants, partly Finland), per member counted on
  a reference date (Norway's LAM through "samordnet rapportering", Denmark's
  medlemstilskud via CFR, Germany's Bestandserhebung, Dutch municipal youth
  grants) and per leader (Germany's Übungsleiterzuschuss, parts of LOK).
  Rules change by date (LOK's rules of 1 July 2025 replaced those of 2023:
  ages 6–25, 20 participants per leader, one group activity per sport and
  day, 3 or 5 a week), caps span several sessions, municipalities add their
  own variants, and reporting goes through national platforms (since 10
  November 2026 RF's Idrottsarenan with an integration platform for vendors),
  files (the municipal XML file) or forms.
- **Background checks** differ in who asks (the person: SE, DE, BE, AT, ES;
  the club with consent: NO, DK, FI, IE, NL, PL, EE; the federation
  automatically: FR), how old a certificate may be when shown (6 months in
  SE and FI, 3 in DE), how often to re-check (once to yearly), whether a copy
  may be kept (almost never) and how it is verified (looked at, a code
  checked with the authority, shared through a digital mailbox, received by
  the club, a federation feed).

**Decision.**

1. **Plugins, not country-pack interfaces.** Grant reporting and background
   checks are provided by **plugins** that we or third parties write. Country
   packs keep what is the same for a whole country and simple (ages, personal
   identity numbers, holidays, locale defaults, imports); `GrantRules` moves
   into the Swedish LOK plugin, `ClearanceRules` is never built as a pack
   interface.
2. **One plugin contract** (`packages/plugin-api`), versioned by semver:
   - a **manifest**: id, version, publisher, licence, the plugin-API version
     it needs, its capabilities, the countries or regions it serves, the
     **data it needs** (declared fields; nothing else is given to it), its
     per-club configuration schema, the hosts it may call, and its texts in
     sv, en and nb (reason codes, labels);
   - **capabilities**: `grant-reporting` and `background-checks` first;
     more may come (federation exports, signature providers, ADR 0049);
   - every input and output is JSON-serialisable and every call is
     asynchronous, so the same contract can run **in process** (a package)
     or **out of process** (an HTTP service) later.
3. **The host owns data, the plugin owns rules.** A plugin never gets a
   database connection. The host gives it a context with exactly the
   declared data, minimised and pseudonymous where possible (a personal
   identity number only if declared, decrypted by the host for that call
   and never logged), the club's configuration, encrypted secrets, a clock,
   a logger without personal data, an HTTP client limited to the declared
   hosts, and a small key-value state per club. The host stores results,
   locks periods, audits submissions and applies the rules of ADR 0047
   (a club may only be stricter).
4. **Installation and activation.** The operator (or a self-hosting
   organisation) installs plugins for the installation, with an allow list
   of licences (`docs/licensing.md`); a club enables the ones it wants and
   configures them (`club.plugins.manage`). In-process plugins are trusted
   code reviewed like our own; untrusted third parties use the
   out-of-process transport when it comes. A plugin's failure (exception,
   timeout) is contained: the report or check shows an error, the request
   does not fail.
5. **Grant reporting contract.** A plugin declares **schemes** (key, name,
   basis `session` | `membership_snapshot` | `leader`, periods per year with
   from, to, deadline and late rules, required fields, export formats and
   integrations). It evaluates single sessions (the live hints in the
   attendance view), whole periods (rules across sessions: caps per day and
   week, leaders per participants), membership snapshots on a reference date
   (counts per age band, sex, sport, residence), and turns a locked report
   into files (CSV, XML, PDF) or a submission to an integration with a
   receipt and status. Results name sessions and people by ID with reason
   codes; missing data is listed per person and field before a period is
   locked. Rules are chosen by the activity's date.
6. **Background-check contract.** A plugin declares **check types**
   (initiator, maximum age when presented, re-check interval, minimum age,
   copy retention, verification methods, cost, integration) and
   **requirements** per duty category (regular contact with children, alone
   with children, overnight, board) with a level and a basis. It runs the
   flows: the person presents (a code checked with the authority, used only
   during the call and never stored), the club requests with consent
   (requested → consent pending → submitted → result → verified or closed),
   or a federation feed. The host stores only metadata: type, country,
   issued, verified, by whom, method, valid until; **never** the document, a
   picture, a reference code or a negative outcome (a negative outcome closes
   the case and ends the duty without recording why: GDPR Art. 10).
7. **References.** Sweden's LOK-stöd and Norway's LAM are the first grant
   plugins, built in this repository to prove the contract; background-check
   plugins (Sweden, Norway) follow. Fixture plugins in the tests model other
   countries (Denmark, Germany, the Netherlands, Finland, France, Ireland,
   Spain) to show the contract can express them.

**Consequences.** Adding a country, a municipality or a new rule set is a
plugin, not a core change. The contract is tested by a conformance suite
every plugin runs, and by scenario tests across countries. The core keeps
the data model (sessions, attendance, members, checks) and the storage of
reports; plugins cannot see more than they declare. **Licence:** the
contract and plugins are AGPL-3.0-only (decision 2026-11-12); an in-process
plugin must be AGPL-compatible. **LOK:** only RF's 2025 rules are
implemented (no session before 2025 is reported), in a structure versioned
by date. Open: the out-of-process transport's security model.
