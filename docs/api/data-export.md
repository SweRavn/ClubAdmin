# "Download my data": the file (schema version 1)

A person (or a full guardian, for a ward) requests the file on
`/me/privacy` or with `POST /api/v1/me/data-exports`; the API's job runner
writes it (`privacy:export`, ADR 0041) and the requester downloads it for
seven days with `GET /api/v1/me/data-exports/{exportId}/download` (a
pre-signed link valid five minutes; a recent login). The file is a ZIP
with two entries:

- `index.html`: the same data for people, in the requester's language,
  with a README (who is responsible for each part, what is not included,
  how to ask a club for more). Self-contained: no scripts, no external
  resources.
- `data.json`: the data for machines, described here.

## data.json

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-02T10:00:00.000Z",
  "locale": "sv",
  "subjectPersonId": "…",
  "requestedByPersonId": "…",
  "parts": [
    { "controller": "platform", "sections": { "person": [ … ], "account": [ … ] } },
    { "controller": "club", "clubId": "…", "clubName": "…", "sections": { "memberships": [ … ] } }
  ],
  "people": { "<personId>": { "name": "Anna Lindqvist", "protected": false } }
}
```

- `parts` lists the platform's part first, then one part per club the
  subject has or had a relationship with (membership, event sign-up or
  application). `controller` says who is responsible for the part under
  GDPR: the platform, or the club.
- Each section is an array of rows. Keys are camelCase forms of the
  database columns; times are ISO 8601 in UTC; dates are `YYYY-MM-DD`.
- People other than the subject appear as IDs (keys ending in `PersonId`,
  `PersonIds` or `WardIds`); `people` names those the requester may see in
  ClubAdmin, as the API would show them (ADR 0022). An ID without an entry
  in `people` is someone the requester cannot see.
- Clients ignore unknown keys and sections: later versions add, never
  remove or rename (`schemaVersion` changes only when they must).

### The platform's part

| Section               | Rows                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `person`              | The person: name, birth date, gender, protected identity, phone, address; `personalIdentityNumber` (`country`, `value`) when stored           |
| `account`             | Login email, language, time zone, theme, notification settings (never the identity provider's subject or session handles)                     |
| `pushDevices`         | Phones with notifications: service, platform, app variant, last used, turned off (never the token)                                            |
| `calendarFeeds`       | Calendar subscriptions (P1.11): scope, club and group, the chosen people, label, last fetched, revoked and why (never the secret or its hash) |
| `guardianships`       | Family links where the subject is the guardian or the child: kind, rights, status, period, the decision at the adult age                      |
| `guardianInvitations` | Family invitations the subject sent (without the invited address)                                                                             |
| `notifications`       | The inbox of the last 90 days: type, category, what it is about, read                                                                         |
| `dataExports`         | Requests for the subject's data (also this one)                                                                                               |
| `erasureRequests`     | Account deletion and erasure requests concerning the subject                                                                                  |
| `history`             | Record history of the person row and the account (secrets, hashes and email addresses removed)                                                |

### A club's part

| Section              | Rows                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `clubProfile`        | Member number, fields shared with the club, emergency contacts, protected in the club (never the club's notes) |
| `memberships`        | Status, type, period                                                                                           |
| `groupMemberships`   | Group, function, period                                                                                        |
| `roles`              | Club roles and who gave them                                                                                   |
| `employments`        | Employment in the club                                                                                         |
| `consents`           | Purpose, text version, how and by whom given, withdrawn; `text`: the text agreed to, in the file's language    |
| `joinRequests`       | Applications, the person's message and the club's answer                                                       |
| `waitingLists`       | Waiting-list places with the applicant's note (never the owner's)                                              |
| `responses`          | Answers to activities, with the activity's title and start                                                     |
| `attendance`         | Attendance marks                                                                                               |
| `callUps`            | Call-ups                                                                                                       |
| `eventRegistrations` | Sign-ups with answers; `sensitiveAnswers` decrypted (only in this file)                                        |
| `invitationsSent`    | Club invitations the subject sent (without addresses)                                                          |
| `history`            | Record history of the rows above (the club's notes, addresses and secrets removed)                             |

## Not included

The clubs' internal notes on people (a club answers a full access request
itself), other people's contact details, the audit log's IP hashes, and
backups (they expire; ADR 0030). Chat, documents, accounting records and
background-check metadata join the file when their modules exist.
