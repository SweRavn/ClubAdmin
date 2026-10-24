// SPDX-License-Identifier: AGPL-3.0-only
// "My schedule" (P1.4, ADR 0034): the activities of my groups and of my
// wards' groups (those whose schedule I may see: the view_schedule right),
// across clubs. When acting on behalf of a ward, only the ward's schedule.

import {
  type ResponseMode,
  type SchedulePage,
  SchedulePageSchema,
  type ScheduleQuery,
  ScheduleQuerySchema,
} from "@clubadmin/shared";
import { Controller, Query } from "@nestjs/common";

import { Endpoint } from "../../platform/http/endpoint.ts";
import { ProblemError } from "../../platform/http/problem-error.ts";
import {
  CurrentAuthorization,
  PersonPresenter,
  type RequestAuthorization,
} from "../authorization/index.ts";
import { PeopleService } from "../people/index.ts";
import { ActivitiesService } from "./activities.service.ts";
import { respondablePeople } from "./attendance.controller.ts";
import { answerState } from "./attendance.service.ts";

/** Me, and the wards whose schedule I may see (none when acting on behalf). */
export function schedulePeople(authz: RequestAuthorization): string[] {
  const actor = authz.actor;
  return [
    actor.personId,
    ...actor.relationships.wards
      .filter((w) => w.rights.includes("view_schedule"))
      .map((w) => w.personId),
  ].filter((id, i, all) => all.indexOf(id) === i);
}

@Controller()
export class ScheduleController {
  private readonly activities: ActivitiesService;
  private readonly people: PeopleService;
  private readonly presenter: PersonPresenter;

  constructor(activities: ActivitiesService, people: PeopleService, presenter: PersonPresenter) {
    this.activities = activities;
    this.people = people;
    this.presenter = presenter;
  }

  @Endpoint({
    method: "GET",
    path: "me/schedule",
    summary: "My schedule: the activities of my groups and my wards' groups, across clubs",
    tags: ["activities"],
    access: { authenticated: true },
    request: { query: ScheduleQuerySchema },
    response: SchedulePageSchema,
  })
  async schedule(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ScheduleQuery,
  ): Promise<SchedulePage> {
    const everyone = schedulePeople(authz);
    if (query.personId && !everyone.includes(query.personId)) {
      throw new ProblemError("not-found");
    }
    const people = await this.presenter.present(
      authz,
      null,
      await this.people.summaries(authz.context, everyone),
    );
    const shown = new Map(people.map((p) => [p.id, p]));
    const page = await this.activities.schedule(authz.context, {
      personIds: query.personId ? [query.personId] : everyone,
      from: query.from,
      to: query.to,
      clubId: query.clubId,
      cursor: query.cursor,
      limit: query.limit,
    });
    const changedSince = query.changedSince ? Date.parse(query.changedSince) : null;
    const respondable = new Set(respondablePeople(authz));
    const now = new Date();
    return {
      items: page.items.flatMap((row) => {
        const club = page.clubs.get(row.clubId);
        if (!club) return [];
        return [
          {
            activityId: row.activityId,
            club: { id: row.clubId, name: club.name, timeZone: club.timeZone },
            kind: row.kind as SchedulePage["items"][number]["kind"],
            title: row.title,
            status: row.status as SchedulePage["items"][number]["status"],
            cancelledReason: row.cancelledReason,
            startsAt: row.startsAt.toISOString(),
            endsAt: row.endsAt.toISOString(),
            allDay: row.allDay,
            meetAt: row.meetAt?.toISOString() ?? null,
            place: row.place,
            groups: row.groupIds
              .flatMap((id) => {
                const name = page.groups.get(id);
                return name === undefined ? [] : [{ id, name }];
              })
              .sort((a, b) => a.name.localeCompare(b.name)),
            people: row.personIds.flatMap((id) => {
              const person = shown.get(id);
              return person ? [person] : [];
            }),
            changed: changedSince !== null && row.changedAt.getTime() > changedSince,
            changedAt: row.changedAt.toISOString(),
            eventId: row.eventId,
            responseMode: row.responseMode as ResponseMode,
            respondBy: row.respondBy?.toISOString() ?? null,
            responses: row.personIds.flatMap((id) => {
              if (!shown.has(id)) return [];
              const open = answerState(
                {
                  status: row.status,
                  responseMode: row.responseMode,
                  endsAt: row.endsAt,
                  respondBy: row.respondBy,
                },
                now,
              ).open;
              const status = row.answers[id];
              return [
                {
                  personId: id,
                  status: status === "attending" || status === "not_attending" ? status : null,
                  canRespond: open && respondable.has(id) && row.memberIds.includes(id),
                },
              ];
            }),
          },
        ];
      }),
      nextCursor: page.nextCursor,
      people,
    };
  }
}
