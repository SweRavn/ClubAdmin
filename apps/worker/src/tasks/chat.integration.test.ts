// SPDX-License-Identifier: AGPL-3.0-only
// Chat jobs (P2.1): the daily maintenance creates partitions and the
// groups' default channels; syncing a person follows their groups and the
// guardian rule; someone without a relationship to the club leaves its chats.

import { createTestDatabase, type TestDatabase } from "@clubadmin/db/testing";
import { uuidv7 } from "@clubadmin/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runChatMaintenance, syncPerson } from "./chat.ts";

let t: TestDatabase;
const club = uuidv7();
const group = uuidv7();
const coach = uuidv7();
const kid = uuidv7();
const parent = uuidv7();
const latecomer = uuidv7();

async function admin(statement: string, params: unknown[] = []) {
  return t.query("admin", statement, params);
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const [id, name, born] of [
    [coach, "Coach", "1980-01-01"],
    [kid, "Kid", "2015-05-05"],
    [parent, "Parent", "1984-02-02"],
    [latecomer, "Late", "1990-03-03"],
  ] as const) {
    await admin(
      "INSERT INTO people (id, given_name, family_name, birth_date) VALUES ($1, $2, 'Chat', $3)",
      [id, name, born],
    );
  }
  const c = await t.connect("admin");
  try {
    await c.query("BEGIN");
    await c.query(
      `INSERT INTO clubs (id, name, slug, country, default_locale, time_zone, currency)
       VALUES ($1, 'Chat IF', $2, 'SE', 'sv-SE', 'Europe/Stockholm', 'SEK')`,
      [club, `chat-${club.slice(-8)}`],
    );
    await c.query(
      "INSERT INTO club_role_assignments (club_id, person_id, role) VALUES ($1, $2, 'club_manager')",
      [club, coach],
    );
    await c.query("COMMIT");
  } finally {
    await c.end();
  }
  await admin("INSERT INTO groups (id, club_id, name, kind) VALUES ($1, $2, 'P2015', 'team')", [
    group,
    club,
  ]);
  for (const id of [coach, kid, latecomer]) {
    await admin(
      "INSERT INTO club_memberships (club_id, person_id, status, membership_type) VALUES ($1, $2, 'active', 'active')",
      [club, id],
    );
  }
  await admin(
    `INSERT INTO guardianships (guardian_person_id, ward_person_id, kind, rights, status)
     VALUES ($1, $2, 'parent', '{act_on_behalf,receive_messages,view_schedule,sign_up,see_medical}', 'active')`,
    [parent, kid],
  );
  await admin(
    "INSERT INTO group_memberships (club_id, group_id, person_id, function) VALUES ($1, $2, $3, 'head_coach'), ($1, $2, $4, 'member')",
    [club, group, coach, kid],
  );
});
afterAll(async () => {
  await t?.drop();
});

const members = async (chatId: string) =>
  (
    await admin(
      "SELECT person_id, reason, status FROM chat_members WHERE chat_id = $1 ORDER BY person_id",
      [chatId],
    )
  ).rows as { person_id: string; reason: string; status: string }[];

describe("chat jobs", () => {
  let chatId: string;

  it("maintenance creates the coming partitions and the groups' channels, with the guardian rule", async () => {
    const result = await runChatMaintenance(t.db);
    expect(result.partitionsSkipped).toBe(0);
    expect(result.defaultChannels).toBeGreaterThanOrEqual(1);
    const { rows } = await admin("SELECT id FROM chats WHERE default_for_group_id = $1", [group]);
    chatId = (rows[0] as { id: string }).id;
    const list = await members(chatId);
    expect(list.find((m) => m.person_id === parent)).toMatchObject({
      reason: "guardian_auto",
      status: "active",
    });
    expect(list.find((m) => m.person_id === kid)?.reason).toBe("group");
    const again = await runChatMaintenance(t.db);
    expect(again.defaultChannels).toBe(0);
  });

  it("syncing a person who joined the group adds them to its channel", async () => {
    await admin(
      "INSERT INTO group_memberships (club_id, group_id, person_id, function) VALUES ($1, $2, $3, 'member')",
      [club, group, latecomer],
    );
    expect(await syncPerson(t.db, club, latecomer)).toContain(chatId);
    expect((await members(chatId)).find((m) => m.person_id === latecomer)?.status).toBe("active");
  });

  it("someone who leaves the group leaves its channel; without the leader the guardians leave", async () => {
    await admin(
      "UPDATE group_memberships SET valid_to = now() WHERE person_id = $1 AND group_id = $2",
      [coach, group],
    );
    await syncPerson(t.db, club, coach);
    const list = await members(chatId);
    expect(list.find((m) => m.person_id === coach)?.status).toBe("left");
    // The latecomer is an adult who is not the kid's guardian: the parent stays.
    expect(list.find((m) => m.person_id === parent)?.status).toBe("active");
    await admin(
      "UPDATE group_memberships SET valid_to = now() WHERE person_id = $1 AND group_id = $2",
      [latecomer, group],
    );
    await syncPerson(t.db, club, latecomer);
    expect((await members(chatId)).find((m) => m.person_id === parent)?.status).toBe("left");
  });

  it("someone with no relationship to the club leaves its chats", async () => {
    await admin(
      "UPDATE club_memberships SET valid_to = now(), status = 'left' WHERE person_id = $1",
      [latecomer],
    );
    await admin(
      "INSERT INTO chat_members (club_id, chat_id, person_id, reason) VALUES ($1, $2, $3, 'joined') ON CONFLICT (chat_id, person_id) DO UPDATE SET status = 'active', left_at = NULL",
      [club, chatId, latecomer],
    );
    await syncPerson(t.db, club, latecomer);
    expect((await members(chatId)).find((m) => m.person_id === latecomer)?.status).toBe("left");
  });
});
