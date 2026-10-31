// SPDX-License-Identifier: AGPL-3.0-only
// Notifications (P1.7) against PostgreSQL: who gets which notice, the
// channels by settings and devices, the daily email and the 24-hour rule,
// quiet hours, debounced late declines, reminders, push failures,
// redelivery and the email to the old address. Needs the local services.

import { outbox, sql } from "@clubadmin/db";
import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { hashPushToken, sealPushToken } from "@clubadmin/server-kit/notifications";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { memoryMailProvider } from "../mail.ts";
import {
  deliverDigests,
  deliverEmails,
  deliverPush,
  type DeliveryDependencies,
} from "./deliver.ts";
import { emailAtOnce, nextDigest, quietUntil } from "./fanout.ts";
import { notificationsHandler } from "./handler.ts";
import { memoryPushProvider } from "./push.ts";
import { eventRemindersTask, fanoutTask, responseRemindersTask } from "./tasks.ts";

let t: TestDatabase;
const KEY = "worker-test-notification-key-0123456789";
const WEB = "https://clubadmin.test";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.drop();
});

const handler = (now?: Date) =>
  notificationsHandler({
    channels: { email: true, push: true },
    mail: { webUrl: WEB, invitationTokenKey: undefined },
    ...(now ? { now: () => now } : {}),
  });

function delivery(mail = memoryMailProvider(), push = memoryPushProvider()) {
  const deps: DeliveryDependencies = {
    db: t.db,
    mail,
    push,
    tokenKey: KEY,
    webUrl: WEB,
    mailOptions: { webUrl: WEB, invitationTokenKey: undefined },
    pushPerHour: 10,
  };
  return { deps, mail, push };
}

const helpers = { logger: { info: () => undefined, debug: () => undefined } } as never;

/**
 * A club with team F2016: a coach; Elsa (child, no account) with Anna (parent,
 * a phone with push) and Mikael (parent, no phone, English); Gunilla (relative,
 * view_schedule only); Nils (contact person: receive_messages + view_schedule).
 */
async function team() {
  const ids = {
    club: uuidv7(),
    group: uuidv7(),
    coach: uuidv7(),
    elsa: uuidv7(),
    anna: uuidv7(),
    mikael: uuidv7(),
    gunilla: uuidv7(),
    nils: uuidv7(),
  };
  const s = await t.connect("admin");
  try {
    await s.query("BEGIN");
    await s.query(
      `INSERT INTO people (id, given_name, family_name) VALUES
        ($1, 'Kim', 'Coach'), ($2, 'Elsa', 'Lindqvist'), ($3, 'Anna', 'Lindqvist'),
        ($4, 'Mikael', 'Lindqvist'), ($5, 'Gunilla', 'Berg'), ($6, 'Nils', 'Granqvist')`,
      [ids.coach, ids.elsa, ids.anna, ids.mikael, ids.gunilla, ids.nils],
    );
    for (const [person, locale] of [
      [ids.coach, "sv"],
      [ids.anna, "sv"],
      [ids.mikael, "en"],
      [ids.gunilla, "sv"],
      [ids.nils, "sv"],
    ] as const) {
      await s.query(
        `INSERT INTO accounts (person_id, email, email_verified_at, locale) VALUES ($1, $2, now(), $3)`,
        [person, `p-${person.slice(-12)}@example.test`, locale],
      );
    }
    await s.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Notis IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [ids.club, `notis-${ids.club.slice(-8)}`],
    );
    await s.query(
      `INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')`,
      [ids.club, ids.coach],
    );
    await s.query(`INSERT INTO groups (id, club_id, kind, name) VALUES ($1, $2, 'team', 'F2016')`, [
      ids.group,
      ids.club,
    ]);
    await s.query(
      `INSERT INTO group_memberships (club_id, group_id, person_id, function, valid_from) VALUES
        ($1, $2, $3, 'head_coach', now() - interval '1 year'),
        ($1, $2, $4, 'member', now() - interval '1 year')`,
      [ids.club, ids.group, ids.coach, ids.elsa],
    );
    await s.query(
      `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights) VALUES
        ($1, $5, 'parent', '{act_on_behalf,receive_messages,view_schedule,sign_up,see_medical}'),
        ($2, $5, 'parent', '{act_on_behalf,receive_messages,view_schedule,sign_up,see_medical}'),
        ($3, $5, 'relative', '{view_schedule}'),
        ($4, $5, 'contact_person', '{view_schedule,receive_messages}')`,
      [ids.anna, ids.mikael, ids.gunilla, ids.nils, ids.elsa],
    );
    const token = `ExponentPushToken[anna-${ids.anna.slice(-8)}]`;
    await s.query(
      `INSERT INTO push_devices (account_id, token_hash, token_sealed, platform)
       SELECT id, $2, $3, 'ios' FROM accounts WHERE person_id = $1`,
      [ids.anna, hashPushToken(token), sealPushToken(KEY, token)],
    );
    await s.query("COMMIT");
    return { ...ids, annaToken: token };
  } finally {
    await s.end();
  }
}

async function activity(
  x: Awaited<ReturnType<typeof team>>,
  startsInMs: number,
  options: { responseMode?: string; respondByInMs?: number } = {},
): Promise<string> {
  const id = uuidv7();
  const starts = new Date(Date.now() + startsInMs);
  await t.query(
    "admin",
    `INSERT INTO activities (id, club_id, kind, title, starts_at, ends_at, created_by_person_id, response_mode, respond_by)
     VALUES ($1, $2, 'training', 'Träning', $3, $4, $5, $6, $7)`,
    [
      id,
      x.club,
      starts,
      new Date(starts.getTime() + HOUR),
      x.coach,
      options.responseMode ?? "optional",
      options.respondByInMs === undefined ? null : new Date(Date.now() + options.respondByInMs),
    ],
  );
  await t.query(
    "admin",
    `INSERT INTO activity_groups (club_id, activity_id, group_id) VALUES ($1, $2, $3)`,
    [x.club, id, x.group],
  );
  return id;
}

const publish = (clubId: string, type: Parameters<typeof outbox.publish>[1], payload: object) =>
  t.db.withSystem("test", { clubId }, (tx) => outbox.publish(tx, type, payload as never));

async function noticesOf(personId: string) {
  const { rows } = await t.query<{ type: string; about_person_ids: string[]; id: string }>(
    "admin",
    "SELECT id, type, about_person_ids FROM notifications WHERE recipient_person_id = $1 ORDER BY id",
    [personId],
  );
  return rows;
}

async function deliveriesOf(personId: string) {
  const { rows } = await t.query<{ channel: string; status: string; digest: boolean }>(
    "admin",
    `SELECT d.channel, d.status, d.digest FROM notification_deliveries d
     JOIN notifications n ON n.id = d.notification_id WHERE n.recipient_person_id = $1 ORDER BY d.channel`,
    [personId],
  );
  return rows;
}

describe("timing rules", () => {
  it("emails at once what is due before the next daily email plus 24 hours", () => {
    const now = new Date("2026-11-02T10:00:00Z"); // 11:00 in Stockholm
    const digest = nextDigest(now, "Europe/Stockholm");
    expect(digest.toISOString()).toBe("2026-11-02T16:00:00.000Z"); // 17:00 local
    expect(emailAtOnce("activity.cancelled", new Date("2026-11-03T15:00:00Z"), digest)).toBe(true);
    expect(emailAtOnce("activity.cancelled", new Date("2026-11-03T17:00:00Z"), digest)).toBe(false);
    expect(emailAtOnce("members.exported", null, digest)).toBe(true);
    expect(nextDigest(new Date("2026-11-02T16:30:00Z"), "Europe/Stockholm").toISOString()).toBe(
      "2026-11-03T16:00:00.000Z",
    );
  });

  it("knows the quiet hours across midnight", () => {
    const quiet = { from: "21:00", to: "07:00" };
    expect(
      quietUntil(new Date("2026-11-02T21:30:00Z"), "Europe/Stockholm", quiet)?.toISOString(),
    ).toBe("2026-11-03T06:00:00.000Z");
    expect(
      quietUntil(new Date("2026-11-02T04:00:00Z"), "Europe/Stockholm", quiet)?.toISOString(),
    ).toBe("2026-11-02T06:00:00.000Z");
    expect(quietUntil(new Date("2026-11-02T12:00:00Z"), "Europe/Stockholm", quiet)).toBeNull();
    expect(quietUntil(new Date("2026-11-02T22:00:00Z"), "Europe/Stockholm", null)).toBeNull();
  });
});

describe("a cancelled activity", () => {
  it("reaches the guardians and the contact person once, by push or email, never the relative", async () => {
    const x = await team();
    const id = await activity(x, 3 * DAY);
    await t.query("admin", "UPDATE activities SET status = 'cancelled' WHERE id = $1", [id]);
    // Outside quiet hours (12:00 in Stockholm).
    const noon = new Date();
    noon.setUTCHours(11, 0, 0, 0);
    const event = await publish(x.club, "activity.changed", {
      clubId: x.club,
      activityId: id,
      change: "cancelled",
    });
    await outbox.dispatch(t.db, event, [handler(noon)]);
    for (const p of [x.anna, x.mikael, x.nils]) {
      expect((await noticesOf(p)).map((n) => [n.type, n.about_person_ids])).toEqual([
        ["activity.cancelled", [x.elsa]],
      ]);
    }
    expect(await noticesOf(x.gunilla)).toEqual([]);
    expect(await noticesOf(x.coach)).toEqual([]);
    // Anna has the app: push, no email (no_app); Mikael has none: email, in three days: the daily email.
    expect(await deliveriesOf(x.anna)).toEqual([
      { channel: "push", status: "queued", digest: false },
    ]);
    expect(await deliveriesOf(x.mikael)).toEqual([
      { channel: "email", status: "held", digest: true },
    ]);

    // A redelivered event creates nothing more.
    await t.query("admin", "DELETE FROM outbox.deliveries WHERE event_id = $1", [event]);
    await t.query("admin", "UPDATE outbox.events SET status = 'pending' WHERE id = $1", [event]);
    await outbox.dispatch(t.db, event, [handler(noon)]);
    expect(await noticesOf(x.anna)).toHaveLength(1);

    const { deps, push } = delivery();
    await deliverPush(deps, new Date());
    const toAnna = push.sent.filter((m) => m.to === x.annaToken);
    expect(toAnna).toHaveLength(1);
    expect(toAnna[0]).toMatchObject({ channelId: "schedule" });
    expect(toAnna[0]!.title).toContain("Inställt: Träning");
    // No names on the lock screen.
    expect(`${toAnna[0]!.title} ${toAnna[0]!.body}`).not.toMatch(/Elsa|Lindqvist/);
  });

  it("emails at once when it is tomorrow (24-hour rule), in the recipient's language with the ward's name", async () => {
    const x = await team();
    const id = await activity(x, 20 * HOUR);
    await t.query("admin", "UPDATE activities SET status = 'cancelled' WHERE id = $1", [id]);
    const event = await publish(x.club, "activity.changed", {
      clubId: x.club,
      activityId: id,
      change: "cancelled",
    });
    await outbox.dispatch(t.db, event, [handler()]);
    expect(await deliveriesOf(x.mikael)).toEqual([
      { channel: "email", status: "queued", digest: false },
    ]);
    const { deps, mail } = delivery();
    await deliverEmails(deps, new Date(Date.now() + 1000));
    const toMikael = mail.sent.filter((m) => m.to.includes(x.mikael.slice(-12)));
    expect(toMikael).toHaveLength(1);
    expect(toMikael[0]!.subject).toContain("Cancelled: Träning");
    expect(toMikael[0]!.text).toContain("About: Elsa Lindqvist");
    expect(toMikael[0]!.text).toContain(`${WEB}/activities/${id}`);
    expect(toMikael[0]!.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("is not news three weeks ahead", async () => {
    const x = await team();
    const id = await activity(x, 21 * DAY);
    const event = await publish(x.club, "activity.changed", {
      clubId: x.club,
      activityId: id,
      change: "cancelled",
    });
    await outbox.dispatch(t.db, event, [handler()]);
    expect(await noticesOf(x.anna)).toEqual([]);
  });
});

describe("call-ups", () => {
  it("are told at once however far ahead, and only to those called up", async () => {
    const x = await team();
    const id = await activity(x, 40 * DAY);
    const event = await publish(x.club, "activity.invitees.changed", {
      clubId: x.club,
      activityId: id,
      added: [x.elsa],
      removed: [],
    });
    await outbox.dispatch(t.db, event, [handler()]);
    expect((await noticesOf(x.anna)).map((n) => n.type)).toEqual(["callup.added"]);
    expect(await noticesOf(x.coach)).toEqual([]);
  });
});

describe("the daily email", () => {
  it("collects every held notice in one email; read ones are left out", async () => {
    const x = await team();
    const [a, b, c] = [
      await activity(x, 5 * DAY),
      await activity(x, 6 * DAY),
      await activity(x, 7 * DAY),
    ];
    for (const id of [a, b, c]) {
      await t.query("admin", "UPDATE activities SET status = 'cancelled' WHERE id = $1", [id]);
      const event = await publish(x.club, "activity.changed", {
        clubId: x.club,
        activityId: id,
        change: "cancelled",
      });
      await outbox.dispatch(t.db, event, [handler()]);
    }
    const [first] = await noticesOf(x.mikael);
    await t.query("admin", "UPDATE notifications SET read_at = now() WHERE id = $1", [first!.id]);
    const { deps, mail } = delivery();
    await deliverDigests(deps, new Date(Date.now() + 2 * DAY));
    const toMikael = mail.sent.filter((m) => m.to.includes(x.mikael.slice(-12)));
    expect(toMikael).toHaveLength(1);
    expect(toMikael[0]!.subject).toBe("ClubAdmin: 2 updates for you");
    expect(toMikael[0]!.text.match(/Cancelled: Träning/g)).toHaveLength(2);
    // Sent once: the next run has nothing.
    await deliverDigests(deps, new Date(Date.now() + 2 * DAY));
    expect(mail.sent.filter((m) => m.to.includes(x.mikael.slice(-12)))).toHaveLength(1);
  });
});

describe("quiet hours", () => {
  it("hold a push until morning, and drop it when it was read meanwhile", async () => {
    const x = await team();
    const id = await activity(x, 5 * DAY);
    await t.query("admin", "UPDATE activities SET status = 'cancelled' WHERE id = $1", [id]);
    const night = new Date();
    night.setUTCHours(22, 0, 0, 0); // 23:00 in Stockholm
    const event = await publish(x.club, "activity.changed", {
      clubId: x.club,
      activityId: id,
      change: "cancelled",
    });
    await outbox.dispatch(t.db, event, [handler(night)]);
    expect(await deliveriesOf(x.anna)).toEqual([
      { channel: "push", status: "held", digest: false },
    ]);
    await t.query(
      "admin",
      "UPDATE notifications SET read_at = now() WHERE recipient_person_id = $1",
      [x.anna],
    );
    const { deps, push } = delivery();
    await deliverPush(deps, new Date(night.getTime() + 12 * HOUR));
    expect(push.sent.filter((m) => m.to === x.annaToken)).toHaveLength(0);
    expect(await deliveriesOf(x.anna)).toEqual([
      { channel: "push", status: "skipped", digest: false },
    ]);
  });
});

describe("late declines", () => {
  it("tell the leaders after five minutes, unless the answer changed back", async () => {
    const x = await team();
    const id = await activity(x, 30 * HOUR, { responseMode: "requested", respondByInMs: -HOUR });
    await t.query(
      "admin",
      `INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
       VALUES ($1, $2, $3, 'not_attending', $4)`,
      [x.club, id, x.elsa, x.anna],
    );
    const event = await publish(x.club, "activity.response.changed", {
      clubId: x.club,
      activityId: id,
      personId: x.elsa,
      change: "set",
    });
    await outbox.dispatch(t.db, event, [handler()]);
    const { rows: jobs } = await t.query<{ key: string }>(
      "admin",
      "SELECT key FROM graphile_worker._private_jobs WHERE key LIKE 'notify:late:%'",
    );
    expect(jobs.map((j) => j.key)).toContain(`notify:late:${id}:${x.elsa}`);

    const run = fanoutTask({ db: t.db, channels: { email: true, push: true } });
    await run({ kind: "late", clubId: x.club, activityId: id, personId: x.elsa }, helpers);
    expect((await noticesOf(x.coach)).map((n) => [n.type, n.about_person_ids])).toEqual([
      ["response.late_decline", [x.elsa]],
    ]);
    expect(await noticesOf(x.anna)).toEqual([]);

    // Changed back: no notice.
    const other = await activity(x, 30 * HOUR, { responseMode: "requested", respondByInMs: -HOUR });
    await t.query(
      "admin",
      `INSERT INTO activity_responses (club_id, activity_id, person_id, status, responded_by_person_id)
       VALUES ($1, $2, $3, 'attending', $4)`,
      [x.club, other, x.elsa, x.anna],
    );
    await run({ kind: "late", clubId: x.club, activityId: other, personId: x.elsa }, helpers);
    expect(await noticesOf(x.coach)).toHaveLength(1);
  });
});

describe("answer reminders", () => {
  it("go once to those who may answer for someone who has not", async () => {
    const x = await team();
    const id = await activity(x, 2 * DAY, { responseMode: "requested", respondByInMs: 12 * HOUR });
    const remind = responseRemindersTask({ db: t.db, channels: { email: true, push: true } });
    await remind({}, helpers);
    await remind({}, helpers);
    expect((await noticesOf(x.anna)).map((n) => n.type)).toEqual(["response.reminder"]);
    // Nils (contact person) may not answer; Gunilla neither.
    expect(await noticesOf(x.nils)).toEqual([]);
    expect(await noticesOf(x.gunilla)).toEqual([]);
    void id;
  });
});

describe("push failures", () => {
  it("disable a device the provider no longer knows", async () => {
    const x = await team();
    const id = await activity(x, 3 * DAY);
    await t.query("admin", "UPDATE activities SET status = 'cancelled' WHERE id = $1", [id]);
    const noon = new Date();
    noon.setUTCHours(11, 0, 0, 0);
    const event = await publish(x.club, "activity.changed", {
      clubId: x.club,
      activityId: id,
      change: "cancelled",
    });
    await outbox.dispatch(t.db, event, [handler(noon)]);
    const push = memoryPushProvider();
    push.unregistered.add(x.annaToken);
    const { deps } = delivery(memoryMailProvider(), push);
    await deliverPush(deps, new Date());
    const { rows } = await t.query<{ disabled: boolean }>(
      "admin",
      `SELECT d.disabled_at IS NOT NULL AS disabled FROM push_devices d JOIN accounts a ON a.id = d.account_id
       WHERE a.person_id = $1`,
      [x.anna],
    );
    expect(rows).toEqual([{ disabled: true }]);
  });
});

describe("email changes", () => {
  it("are told to the old address at once", async () => {
    const x = await team();
    const { rows } = await t.query<{ id: string; email: string }>(
      "admin",
      "SELECT id, email FROM accounts WHERE person_id = $1",
      [x.mikael],
    );
    const account = rows[0]!;
    await t.db.withSystem("test", {}, (tx) =>
      tx.execute(
        sql`UPDATE accounts SET email = ${`new-${account.id.slice(-8)}@example.test`} WHERE id = ${account.id}`,
      ),
    );
    const event = await publish(x.club, "account.email.changed", {
      accountId: account.id,
      personId: x.mikael,
    });
    await outbox.dispatch(t.db, event, [handler()]);
    const { deps, mail } = delivery();
    await deliverEmails(deps, new Date(Date.now() + 1000));
    const sent = mail.sent.filter((m) => m.subject === "Your email address changed");
    expect(sent.map((m) => m.to)).toEqual([account.email]);
    expect(sent[0]!.headers).toEqual({});
  });
});

// --- Every type: who gets it, and who does not (P1.7 acceptance) -------------------

async function event(
  x: Awaited<ReturnType<typeof team>>,
  options: { status?: string; closesInMs?: number; audience?: string } = {},
) {
  const id = uuidv7();
  await t.query(
    "admin",
    `INSERT INTO events (id, club_id, title, audience, status, starts_at, ends_at, registration_closes_at,
                         capacity, created_by_person_id)
     VALUES ($1, $2, 'Cupen', $3, $4, now() + interval '20 days', now() + interval '20 days 6 hours',
             now() + make_interval(secs => $5::double precision / 1000), 10, $6)`,
    [
      id,
      x.club,
      options.audience ?? "groups",
      options.status ?? "published",
      options.closesInMs ?? 10 * DAY,
      x.coach,
    ],
  );
  await t.query(
    "admin",
    `INSERT INTO event_groups (club_id, event_id, group_id) VALUES ($1, $2, $3)`,
    [x.club, id, x.group],
  );
  return id;
}

async function registration(
  x: Awaited<ReturnType<typeof team>>,
  eventId: string,
  status: string,
  by: string,
  decided = false,
) {
  const id = uuidv7();
  await t.query(
    "admin",
    `INSERT INTO event_registrations (id, club_id, event_id, person_id, registered_by_person_id, status,
                                      decided_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, x.club, eventId, x.elsa, by, status, decided ? x.coach : null],
  );
  return id;
}

const types = async (personId: string) => (await noticesOf(personId)).map((n) => n.type);

describe("every type reaches the right people", () => {
  it("activity.restored and activity.added: the roster's guardians and contact person, not the relative", async () => {
    const x = await team();
    const restored = await activity(x, 3 * DAY);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "activity.changed", {
        clubId: x.club,
        activityId: restored,
        change: "restored",
      }),
      [handler()],
    );
    const added = await activity(x, 4 * DAY);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "activity.changed", {
        clubId: x.club,
        activityId: added,
        change: "created",
      }),
      [handler()],
    );
    for (const p of [x.anna, x.mikael, x.nils]) {
      expect(await types(p)).toEqual(["activity.restored", "activity.added"]);
    }
    expect(await types(x.gunilla)).toEqual([]);
    expect(await types(x.coach)).toEqual([]);
  });

  it("activity.added: not for a session of a series, nor far ahead unless answers are asked for", async () => {
    const x = await team();
    const series = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO activity_series (id, club_id, kind, title, slots, starts_on, ends_on, created_by_person_id)
       VALUES ($1, $2, 'training', 'Träning', '[]', current_date, current_date + 60, $3)`,
      [series, x.club, x.coach],
    );
    const inSeries = await activity(x, 2 * DAY);
    await t.query("admin", "UPDATE activities SET series_id = $1 WHERE id = $2", [
      series,
      inSeries,
    ]);
    const far = await activity(x, 30 * DAY);
    const farRequested = await activity(x, 30 * DAY, { responseMode: "requested" });
    for (const id of [inSeries, far, farRequested]) {
      await outbox.dispatch(
        t.db,
        await publish(x.club, "activity.changed", {
          clubId: x.club,
          activityId: id,
          change: "created",
        }),
        [handler()],
      );
    }
    const notices = await noticesOf(x.anna);
    expect(notices.map((n) => n.type)).toEqual(["activity.added"]);
  });

  it("activity.moved: once per version to the roster's guardians; not after it started, nor three weeks ahead", async () => {
    const x = await team();
    const run = fanoutTask({ db: t.db, channels: { email: true, push: true } });
    const soon = await activity(x, 3 * DAY);
    await run({ kind: "activity", clubId: x.club, activityId: soon }, helpers);
    await run({ kind: "activity", clubId: x.club, activityId: soon }, helpers);
    await t.query("admin", "UPDATE activities SET sequence = sequence + 1 WHERE id = $1", [soon]);
    await run({ kind: "activity", clubId: x.club, activityId: soon }, helpers);
    const far = await activity(x, 21 * DAY);
    await run({ kind: "activity", clubId: x.club, activityId: far }, helpers);
    const past = await activity(x, -HOUR);
    await run({ kind: "activity", clubId: x.club, activityId: past }, helpers);
    expect(await types(x.anna)).toEqual(["activity.moved", "activity.moved"]);
    expect(await types(x.nils)).toEqual(["activity.moved", "activity.moved"]);
    expect(await types(x.gunilla)).toEqual([]);
  });

  it("series.changed: the members' guardians when a session is within two weeks", async () => {
    const x = await team();
    const series = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO activity_series (id, club_id, kind, title, slots, starts_on, ends_on, created_by_person_id)
       VALUES ($1, $2, 'training', 'Träning', '[]', current_date, current_date + 60, $3)`,
      [series, x.club, x.coach],
    );
    await t.query(
      "admin",
      `INSERT INTO activity_series_groups (club_id, series_id, group_id) VALUES ($1, $2, $3)`,
      [x.club, series, x.group],
    );
    const run = fanoutTask({ db: t.db, channels: { email: true, push: true } });
    // No session yet: nothing.
    await run({ kind: "series", clubId: x.club, seriesId: series }, helpers);
    expect(await types(x.anna)).toEqual([]);
    const session = await activity(x, 5 * DAY);
    await t.query("admin", "UPDATE activities SET series_id = $1 WHERE id = $2", [series, session]);
    await run({ kind: "series", clubId: x.club, seriesId: series }, helpers);
    expect(await types(x.anna)).toEqual(["series.changed"]);
    expect(await types(x.nils)).toEqual(["series.changed"]);
    expect(await types(x.gunilla)).toEqual([]);
    expect(await types(x.coach)).toEqual([]);
  });

  it("callup.removed: those no longer called up, not the relative", async () => {
    const x = await team();
    const id = await activity(x, 10 * DAY);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "activity.invitees.changed", {
        clubId: x.club,
        activityId: id,
        added: [],
        removed: [x.elsa],
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["callup.removed"]);
    expect(await types(x.gunilla)).toEqual([]);
    expect(await types(x.coach)).toEqual([]);
  });

  it("event.published: the audience's guardians who may sign up; event.cancelled: only those registered", async () => {
    const x = await team();
    const published = await event(x);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.changed", {
        clubId: x.club,
        eventId: published,
        change: "published",
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["event.published"]);
    expect(await types(x.mikael)).toEqual(["event.published"]);
    // Nils (receive_messages, no sign_up) and Gunilla do not sign up anyone.
    expect(await types(x.nils)).toEqual([]);
    expect(await types(x.gunilla)).toEqual([]);

    const unregistered = await event(x, { status: "cancelled" });
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.changed", {
        clubId: x.club,
        eventId: unregistered,
        change: "cancelled",
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["event.published"]);
    const registered = await event(x, { status: "cancelled" });
    await registration(x, registered, "confirmed", x.anna);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.changed", {
        clubId: x.club,
        eventId: registered,
        change: "cancelled",
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["event.published", "event.cancelled"]);
    expect(await types(x.nils)).toEqual([]);
  });

  it("registrations: a new place or queue tells the other guardian, a removal everyone who may sign up", async () => {
    const x = await team();
    const e = await event(x);
    const confirmed = await registration(x, e, "confirmed", x.anna);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.registration.changed", {
        clubId: x.club,
        eventId: e,
        registrationId: confirmed,
        personId: x.elsa,
      }),
      [handler()],
    );
    expect(await types(x.mikael)).toEqual(["event.registration.confirmed"]);
    // Anna signed up herself.
    expect(await types(x.anna)).toEqual([]);

    const other = await event(x);
    const waiting = await registration(x, other, "waitlisted", x.mikael);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.registration.changed", {
        clubId: x.club,
        eventId: other,
        registrationId: waiting,
        personId: x.elsa,
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["event.registration.waitlisted"]);

    const third = await event(x);
    const removed = await registration(x, third, "removed", x.anna, true);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.registration.changed", {
        clubId: x.club,
        eventId: third,
        registrationId: removed,
        personId: x.elsa,
      }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual([
      "event.registration.waitlisted",
      "event.registration.removed",
    ]);
    expect(await types(x.nils)).toEqual([]);
    expect(await types(x.gunilla)).toEqual([]);
  });

  it("event.offer.confirmed: a place given from the queue, to the guardians with receive_messages", async () => {
    const x = await team();
    const e = await event(x);
    const reg = await registration(x, e, "confirmed", x.anna);
    await outbox.dispatch(
      t.db,
      await publish(x.club, "event.offer.made", {
        clubId: x.club,
        eventId: e,
        registrationId: reg,
        personId: x.elsa,
        kind: "confirmed",
      }),
      [handler()],
    );
    for (const p of [x.anna, x.mikael, x.nils]) {
      expect(await types(p)).toEqual(["event.offer.confirmed"]);
    }
    expect(await types(x.gunilla)).toEqual([]);
  });

  it("event.signup.reminder: a day before sign-up closes, those who have not signed up", async () => {
    const x = await team();
    await event(x, { closesInMs: 12 * HOUR });
    const signedUp = await event(x, { closesInMs: 12 * HOUR });
    await registration(x, signedUp, "confirmed", x.anna);
    await event(x, { closesInMs: 5 * DAY });
    const remind = eventRemindersTask({ db: t.db, channels: { email: true, push: true } });
    await remind({}, helpers);
    await remind({}, helpers);
    expect(await types(x.anna)).toEqual(["event.signup.reminder"]);
    expect(await types(x.mikael)).toEqual(["event.signup.reminder"]);
    expect(await types(x.nils)).toEqual([]);
    expect(await types(x.gunilla)).toEqual([]);
  });

  it("club_creation.decided: the person who asked, nobody else", async () => {
    const x = await team();
    const id = uuidv7();
    await t.query(
      "admin",
      `INSERT INTO club_creation_requests (id, requested_by_person_id, status, name, slug, country)
       VALUES ($1, $2, 'rejected', 'Ny klubb', $3, 'SE')`,
      [id, x.anna, `ny-${id.slice(-8)}`],
    );
    await outbox.dispatch(
      t.db,
      await publish(x.club, "club_creation_request.decided", { requestId: id }),
      [handler()],
    );
    expect(await types(x.anna)).toEqual(["club_creation.decided"]);
    expect(await types(x.mikael)).toEqual([]);
    expect(await types(x.coach)).toEqual([]);
  });

  it("family.adult_ended: the former guardian, without naming the young person", async () => {
    const x = await team();
    const { rows } = await t.query<{ id: string }>(
      "admin",
      `UPDATE guardianships SET status = 'ended', valid_to = now() WHERE guardian_person_id = $1 AND ward_person_id = $2
       RETURNING id`,
      [x.mikael, x.elsa],
    );
    await outbox.dispatch(
      t.db,
      await publish(x.club, "guardianship.adult.ended", {
        guardianshipId: rows[0]!.id,
        wardPersonId: x.elsa,
      }),
      [handler()],
    );
    const notices = await noticesOf(x.mikael);
    expect(notices.map((n) => [n.type, n.about_person_ids])).toEqual([["family.adult_ended", []]]);
    expect(await types(x.anna)).toEqual([]);
  });
});
