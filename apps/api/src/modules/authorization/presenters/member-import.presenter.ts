// SPDX-License-Identifier: AGPL-3.0-only
// Member imports (P1.3b): the import (who started it, through the
// PersonPresenter) and its preview rows. A row's names come from the file,
// not from a person yet; they are shown only on the import endpoints, which
// only the club's managers and registrars reach (they may see protected
// members, ADR 0022). Matched and created people go through the
// PersonPresenter. Guardians' emails are never shown, only that they will be
// invited.

import type { schema } from "@clubadmin/db";
import {
  type GuardianshipKind,
  type MemberImport,
  MemberImportOptionsSchema,
  type MemberImportRow,
} from "@clubadmin/shared";

import type { RequestAuthorization } from "../request-authorization.ts";
import type { PersonPresenter, PresentablePerson } from "./person.presenter.ts";

type ImportRecord = typeof schema.memberImports.$inferSelect;
type StagingRow = typeof schema.memberImportRows.$inferSelect;

const fullName = (given: string | null, family: string | null): string | null =>
  [given, family].filter((p) => p).join(" ") || null;

export class MemberImportPresenter {
  private readonly people: PersonPresenter;

  constructor(people: PersonPresenter) {
    this.people = people;
  }

  async imports(
    authorization: RequestAuthorization,
    clubId: string,
    rows: readonly ImportRecord[],
    people: readonly PresentablePerson[],
    me: string | null,
  ): Promise<MemberImport[]> {
    const shown = new Map(
      (await this.people.present(authorization, clubId, people)).map((p) => [p.id, p]),
    );
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      format: row.sourceFormat,
      createdBy: shown.get(row.createdByPersonId) ?? null,
      mine: row.createdByPersonId === me,
      // Headers and samples only while the staging rows exist.
      columns: row.purgedAt ? [] : row.columns,
      columnMap: row.columnMap,
      options: MemberImportOptionsSchema.parse(row.options),
      counts: row.counts,
      detectedSource: row.detectedSource,
      errorCode: row.errorCode,
      createdAt: row.createdAt.toISOString(),
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
    }));
  }

  async rows(
    authorization: RequestAuthorization,
    clubId: string,
    rows: readonly StagingRow[],
    people: readonly PresentablePerson[],
    sendInvitations: boolean,
  ): Promise<MemberImportRow[]> {
    const shown = new Map(
      (await this.people.present(authorization, clubId, people)).map((p) => [p.id, p]),
    );
    return rows.map((row) => {
      const data = row.data;
      const match = row.personId ?? row.matchPersonId;
      return {
        rowNumber: row.rowNumber,
        status: row.status,
        issues: row.issues,
        name: data ? fullName(data.given, data.family) : null,
        birthDate: data?.birthDate ?? null,
        protected: data?.protected ?? false,
        guardianRow: data?.relation != null,
        guardians: (data?.guardians ?? []).map((g) => ({
          name: fullName(g.given, g.family),
          kind: g.kind as GuardianshipKind,
          invited: sendInvitations && g.email !== null && g.personId === null,
        })),
        groups: data?.groupNames ?? [],
        match: match ? (shown.get(match) ?? null) : null,
        resolution: row.resolution,
      };
    });
  }
}
