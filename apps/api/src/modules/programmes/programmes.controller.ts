// SPDX-License-Identifier: AGPL-3.0-only
// Programmes and templates (P2.9, ADR 0054). Laying out and saving check
// every group involved as the events module does: the caller plans each
// group's activities (and its duties for shifts; may create events for an
// event), or holds club.programmes.manage.

import {
  type ApplyProgrammeInput,
  ApplyProgrammeSchema,
  ClubParamsSchema,
  type CopyProgrammeInput,
  CopyProgrammeSchema,
  type CreateProgrammeTemplateInput,
  CreateProgrammeTemplateSchema,
  GroupParamsSchema,
  type MyProgrammes,
  MyProgrammesSchema,
  ProgrammeCreatedSchema,
  type ProgrammeDetail,
  ProgrammeDetailSchema,
  ProgrammeListQuerySchema,
  ProgrammeListSchema,
  ProgrammeParamsSchema,
  type ProgrammePreview,
  ProgrammePreviewSchema,
  type ProgrammeSummary,
  ProgrammeSummarySchema,
  type ProgrammeTemplate,
  ProgrammeTemplateListSchema,
  ProgrammeTemplateParamsSchema,
  ProgrammeTemplateQuerySchema,
  ProgrammeTemplateSchema,
  type ProgrammeTemplateSummary,
  type ProgrammeTimeline,
  ProgrammeTimelineQuerySchema,
  ProgrammeTimelineSchema,
  type UpdateProgrammeTemplateInput,
  UpdateProgrammeTemplateSchema,
  z,
} from "@clubadmin/shared";
import { Body, Controller, Param, Query } from "@nestjs/common";

import { DomainError } from "../../platform/domain/domain-error.ts";
import { Endpoint } from "../../platform/http/endpoint.ts";
import { schedulePeopleOf } from "../activities/index.ts";
import {
  type Actor,
  AuthorizationService,
  canManageGroupActivities,
  canManageProgramme,
  canReadGroupActivities,
  CurrentAuthorization,
  type GroupRef,
  permits,
  type RequestAuthorization,
  resourceOf,
  tenantContext,
} from "../authorization/index.ts";
import {
  type Layout,
  type LayoutRequirements,
  type ProgrammeRow,
  ProgrammesService,
  type StoredItem,
  type TemplateRow,
} from "./programmes.service.ts";

const TAGS = ["programmes"];

type ListQuery = z.infer<typeof ProgrammeTemplateQuerySchema>;
type ProgrammeListQuery = z.infer<typeof ProgrammeListQuerySchema>;

@Controller()
export class ProgrammesController {
  private readonly programmes: ProgrammesService;
  private readonly authorization: AuthorizationService;

  constructor(programmes: ProgrammesService, authorization: AuthorizationService) {
    this.programmes = programmes;
    this.authorization = authorization;
  }

  // --- Templates ------------------------------------------------------------------

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/programme-templates",
    summary: "The club's templates and those of the groups the caller plans",
    tags: TAGS,
    access: { permission: "club.programmes.use", resource: "club" },
    request: { params: ClubParamsSchema, query: ProgrammeTemplateQuerySchema },
    response: ProgrammeTemplateListSchema,
  })
  async listTemplates(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ListQuery,
  ): Promise<{ items: ProgrammeTemplateSummary[]; nextCursor: string | null }> {
    const { clubId } = resourceOf(authz, "club");
    const result = await this.programmes.listTemplates(
      tenantContext(authz, clubId),
      { groupIds: query.groupId ? [query.groupId] : null, archived: query.archived },
      { cursor: query.cursor ?? null, limit: query.limit },
    );
    const refs = await this.refs(
      authz,
      clubId,
      result.items.flatMap((t) => t.groupId ?? []),
    );
    const manager = authz.actor.holds("club.programmes.manage", clubId);
    const items = result.items.filter(
      (t) =>
        manager ||
        t.groupId === null ||
        canManageGroupActivities(authz.actor, refs.get(t.groupId)!),
    );
    return {
      items: items.map((t) => toSummary(t, this.canManageTemplate(authz.actor, clubId, t, refs))),
      nextCursor: result.nextCursor,
    };
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/programme-templates",
    summary: "Save a programme, an event, a group's range or an activity as a template",
    tags: TAGS,
    access: { permission: "club.programmes.use", resource: "club" },
    request: { params: ClubParamsSchema, body: CreateProgrammeTemplateSchema },
    response: z.object({ id: z.uuid() }),
    status: 201,
  })
  async createTemplate(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CreateProgrammeTemplateInput,
  ): Promise<{ id: string }> {
    const { clubId } = resourceOf(authz, "club");
    const actor = authz.actor;
    const context = tenantContext(authz, clubId);
    const manager = actor.holds("club.programmes.manage", clubId);
    if (body.groupId) {
      const refs = await this.refs(authz, clubId, [body.groupId]);
      const ref = refs.get(body.groupId);
      if (!ref) throw new DomainError("not_found");
      if (!manager && !canManageGroupActivities(actor, ref))
        throw new DomainError("group_not_managed");
    } else if (!manager) {
      throw new DomainError("not_allowed");
    }
    const sourceGroups = await this.programmes.sourceGroups(context, body.source);
    if (!manager) {
      const refs = await this.refs(authz, clubId, sourceGroups);
      if (
        sourceGroups.some((id) => !refs.get(id) || !canManageGroupActivities(actor, refs.get(id)!))
      ) {
        throw new DomainError("group_not_managed");
      }
      if (sourceGroups.length === 0 && !("empty" in body.source)) {
        throw new DomainError("not_allowed");
      }
    }
    return this.programmes.createTemplate(context, body);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/programme-templates/:templateId",
    summary: "A template: its slots, items, event settings and editions",
    tags: TAGS,
    access: { permission: "programme_template.use", resource: "programme_template" },
    request: { params: ProgrammeTemplateParamsSchema },
    response: ProgrammeTemplateSchema,
  })
  async getTemplate(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<ProgrammeTemplate> {
    const resource = resourceOf(authz, "programme_template");
    const found = await this.programmes.getTemplate(
      tenantContext(authz, resource.clubId),
      resource.templateId,
    );
    const canManage = permits(authz.actor, "programme_template.manage", resource);
    return {
      ...toSummary(found.template, canManage),
      eventSettings: found.template.eventSettings,
      slots: found.slots,
      items: found.items.map(toItem),
      editions: found.editions,
    };
  }

  @Endpoint({
    method: "PATCH",
    path: "clubs/:clubId/programme-templates/:templateId",
    summary: "Rename a template, change its slots, items or event, or archive it",
    tags: TAGS,
    access: { permission: "programme_template.manage", resource: "programme_template" },
    request: { params: ProgrammeTemplateParamsSchema, body: UpdateProgrammeTemplateSchema },
    response: z.null(),
    status: 204,
  })
  async updateTemplate(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: UpdateProgrammeTemplateInput,
  ): Promise<null> {
    const resource = resourceOf(authz, "programme_template");
    await this.programmes.updateTemplate(
      tenantContext(authz, resource.clubId),
      resource.templateId,
      body,
    );
    return null;
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/programme-templates/:templateId",
    summary: "Archive a template (its editions stay)",
    tags: TAGS,
    access: { permission: "programme_template.manage", resource: "programme_template" },
    request: { params: ProgrammeTemplateParamsSchema },
    response: z.null(),
    status: 204,
  })
  async archiveTemplate(@CurrentAuthorization() authz: RequestAuthorization): Promise<null> {
    const resource = resourceOf(authz, "programme_template");
    await this.programmes.updateTemplate(
      tenantContext(authz, resource.clubId),
      resource.templateId,
      { archived: true },
    );
    return null;
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/programme-templates/:templateId/preview",
    summary: "Lay a template out on a first day without writing: items, warnings, refusals",
    tags: TAGS,
    access: { permission: "programme_template.use", resource: "programme_template" },
    request: { params: ProgrammeTemplateParamsSchema, body: ApplyProgrammeSchema },
    response: ProgrammePreviewSchema,
    status: 200,
  })
  async preview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: ApplyProgrammeInput,
  ): Promise<ProgrammePreview> {
    const resource = resourceOf(authz, "programme_template");
    const from = { templateId: resource.templateId };
    await this.requireLayout(authz, resource.clubId, from, body);
    return toPreview(
      await this.programmes.preview(tenantContext(authz, resource.clubId), from, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/programme-templates/:templateId/apply",
    summary: "Lay a template out: the programme, event, activities and shifts, all or nothing",
    tags: TAGS,
    access: { permission: "programme_template.use", resource: "programme_template" },
    request: { params: ProgrammeTemplateParamsSchema, body: ApplyProgrammeSchema },
    response: ProgrammeCreatedSchema,
    status: 201,
  })
  async apply(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: ApplyProgrammeInput,
  ): Promise<z.infer<typeof ProgrammeCreatedSchema>> {
    const resource = resourceOf(authz, "programme_template");
    const from = { templateId: resource.templateId };
    await this.requireLayout(authz, resource.clubId, from, body);
    const created = await this.programmes.apply(tenantContext(authz, resource.clubId), from, body);
    return {
      programme: summary(created.programme, created.groupNames),
      activities: created.activities,
      dutyShifts: created.dutyShifts,
    };
  }

  // --- Programmes -----------------------------------------------------------------

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/programmes/:programmeId/copy/preview",
    summary: "Copy a programme to a new date without writing: items, warnings, refusals",
    tags: TAGS,
    access: { permission: "programme.manage", resource: "programme" },
    request: { params: ProgrammeParamsSchema, body: CopyProgrammeSchema },
    response: ProgrammePreviewSchema,
    status: 200,
  })
  async copyPreview(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CopyProgrammeInput,
  ): Promise<ProgrammePreview> {
    const resource = resourceOf(authz, "programme");
    const from = { programmeId: resource.programmeId };
    await this.requireLayout(authz, resource.clubId, from, body);
    return toPreview(
      await this.programmes.preview(tenantContext(authz, resource.clubId), from, body),
    );
  }

  @Endpoint({
    method: "POST",
    path: "clubs/:clubId/programmes/:programmeId/copy",
    summary: "Copy a programme to a new date (no template is kept)",
    tags: TAGS,
    access: { permission: "programme.manage", resource: "programme" },
    request: { params: ProgrammeParamsSchema, body: CopyProgrammeSchema },
    response: ProgrammeCreatedSchema,
    status: 201,
  })
  async copy(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Body() body: CopyProgrammeInput,
  ): Promise<z.infer<typeof ProgrammeCreatedSchema>> {
    const resource = resourceOf(authz, "programme");
    const from = { programmeId: resource.programmeId };
    await this.requireLayout(authz, resource.clubId, from, body);
    const created = await this.programmes.apply(tenantContext(authz, resource.clubId), from, body);
    return {
      programme: summary(created.programme, created.groupNames),
      activities: created.activities,
      dutyShifts: created.dutyShifts,
    };
  }

  @Endpoint({
    method: "POST",
    path: "events/:eventId/programme",
    summary: "The event's programme, made from its sessions and shifts when first opened",
    tags: TAGS,
    access: { permission: "event.manage", resource: "event" },
    request: { params: z.object({ eventId: z.uuid() }) },
    response: ProgrammeSummarySchema,
    status: 200,
  })
  async eventProgramme(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Param() params: { eventId: string },
  ): Promise<ProgrammeSummary> {
    const event = resourceOf(authz, "event");
    const found = await this.programmes.ensureEventProgramme(
      tenantContext(authz, event.clubId),
      params.eventId,
    );
    return summary(found.programme, found.groupNames);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/programmes",
    summary: "The club's programmes, by first day",
    tags: TAGS,
    access: { permission: "club.activities.read", resource: "club" },
    request: { params: ClubParamsSchema, query: ProgrammeListQuerySchema },
    response: ProgrammeListSchema,
  })
  async listClubProgrammes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ProgrammeListQuery,
  ): Promise<{ items: ProgrammeSummary[]; nextCursor: string | null }> {
    const { clubId } = resourceOf(authz, "club");
    return this.list(authz, clubId, null, query);
  }

  @Endpoint({
    method: "GET",
    path: "groups/:groupId/programmes",
    summary: "A group's programmes, by first day",
    tags: TAGS,
    access: { permission: "group.activities.read", resource: "group" },
    request: { params: GroupParamsSchema, query: ProgrammeListQuerySchema },
    response: ProgrammeListSchema,
  })
  async listGroupProgrammes(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: ProgrammeListQuery,
  ): Promise<{ items: ProgrammeSummary[]; nextCursor: string | null }> {
    const group = resourceOf(authz, "group");
    return this.list(authz, group.clubId, group.groupId, query);
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/programmes/:programmeId",
    summary: "A programme: its groups, days and places",
    tags: TAGS,
    access: { permission: "programme.read", resource: "programme" },
    request: { params: ProgrammeParamsSchema },
    response: ProgrammeDetailSchema,
  })
  async getProgramme(
    @CurrentAuthorization() authz: RequestAuthorization,
  ): Promise<ProgrammeDetail> {
    const resource = resourceOf(authz, "programme");
    const found = await this.programmes.getProgramme(
      tenantContext(authz, resource.clubId),
      resource.programmeId,
    );
    return {
      ...summary(found.programme, found.groupNames),
      timeZone: found.timeZone,
      days: found.days,
      places: found.places,
      canManage: canManageProgramme(authz.actor, resource),
      untouched: found.untouched,
    };
  }

  @Endpoint({
    method: "GET",
    path: "clubs/:clubId/programmes/:programmeId/timeline",
    summary: "One day of a programme as the caller may see it: activities and shifts",
    tags: TAGS,
    access: { permission: "programme.read", resource: "programme" },
    request: { params: ProgrammeParamsSchema, query: ProgrammeTimelineQuerySchema },
    response: ProgrammeTimelineSchema,
  })
  async timeline(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { day: string },
  ): Promise<ProgrammeTimeline> {
    const resource = resourceOf(authz, "programme");
    const actor = authz.actor;
    const organiser =
      canManageProgramme(actor, resource) || actor.holds("club.activities.read", resource.clubId);
    const result = await this.programmes.timeline(
      tenantContext(authz, resource.clubId),
      resource.programmeId,
      query.day,
      {
        organiser,
        visibleGroupIds: new Set(
          resource.groups.filter((g) => canReadGroupActivities(actor, g)).map((g) => g.groupId),
        ),
        family: schedulePeopleOf(actor),
      },
    );
    return {
      day: query.day,
      activities: result.activities.map(({ groupIds: _ids, ...a }) => a),
      shifts: result.shifts,
    };
  }

  @Endpoint({
    method: "DELETE",
    path: "clubs/:clubId/programmes/:programmeId",
    summary: "Remove a programme with all its items while nothing is answered or registered",
    tags: TAGS,
    access: { permission: "programme.manage", resource: "programme" },
    request: { params: ProgrammeParamsSchema },
    response: z.null(),
    status: 204,
  })
  async deleteProgramme(@CurrentAuthorization() authz: RequestAuthorization): Promise<null> {
    const resource = resourceOf(authz, "programme");
    await this.programmes.deleteProgramme(
      tenantContext(authz, resource.clubId),
      resource.programmeId,
    );
    return null;
  }

  @Endpoint({
    method: "GET",
    path: "me/programmes",
    summary: "Coming programmes of my groups and my family's in a club",
    tags: TAGS,
    access: { authenticated: true },
    request: { query: z.object({ clubId: z.uuid() }) },
    response: MyProgrammesSchema,
  })
  async mine(
    @CurrentAuthorization() authz: RequestAuthorization,
    @Query() query: { clubId: string },
  ): Promise<MyProgrammes> {
    const actor = authz.actor;
    const people = new Set(schedulePeopleOf(actor));
    const rel = actor.relationships;
    const groupIds = [
      ...rel.groups.filter((g) => g.clubId === query.clubId).map((g) => g.groupId),
      ...rel.wardGroups
        .filter((g) => g.clubId === query.clubId && people.has(g.personId))
        .map((g) => g.groupId),
    ];
    if (groupIds.length === 0) return { items: [] };
    const found = await this.programmes.programmesOfGroups(tenantContext(authz, query.clubId), [
      ...new Set(groupIds),
    ]);
    return {
      items: found.items.map((p) => ({ ...summary(p, found.groupNames), clubId: p.clubId })),
    };
  }

  // --- Internals ------------------------------------------------------------------

  private async list(
    authz: RequestAuthorization,
    clubId: string,
    groupId: string | null,
    query: ProgrammeListQuery,
  ): Promise<{ items: ProgrammeSummary[]; nextCursor: string | null }> {
    const result = await this.programmes.listProgrammes(
      tenantContext(authz, clubId),
      { groupId, from: query.from ?? null },
      { cursor: query.cursor ?? null, limit: query.limit },
    );
    return {
      items: result.items.map((p) => summary(p, result.groupNames)),
      nextCursor: result.nextCursor,
    };
  }

  private async refs(
    authz: RequestAuthorization,
    clubId: string,
    groupIds: readonly string[],
  ): Promise<Map<string, GroupRef & { archived: boolean }>> {
    if (groupIds.length === 0) return new Map();
    const refs = await this.authorization.groupRefs(authz, clubId, groupIds);
    return new Map(refs.map((r) => [r.groupId, r]));
  }

  private canManageTemplate(
    actor: Actor,
    clubId: string,
    template: TemplateRow,
    refs: ReadonlyMap<string, GroupRef>,
  ): boolean {
    if (actor.holds("club.programmes.manage", clubId)) return true;
    const ref = template.groupId ? refs.get(template.groupId) : undefined;
    return ref !== undefined && canManageGroupActivities(actor, ref);
  }

  /**
   * The caller may lay out into every group involved: plans its activities
   * (its duties too when there are shifts), may create an event when there
   * is one, or holds club.programmes.manage. Archived groups are refused by
   * the service (the preview shows them).
   */
  private async requireLayout(
    authz: RequestAuthorization,
    clubId: string,
    from: { templateId: string } | { programmeId: string },
    body: ApplyProgrammeInput | CopyProgrammeInput,
  ): Promise<LayoutRequirements> {
    const context = tenantContext(authz, clubId);
    const needs = await this.programmes.requirements(context, from, body);
    const actor = authz.actor;
    const refs = await this.refs(authz, clubId, needs.groupIds);
    if (refs.size !== new Set(needs.groupIds).size) throw new DomainError("not_found");
    const manager = actor.holds("club.programmes.manage", clubId);
    for (const ref of refs.values()) {
      if (ref.archived) continue;
      const group = { kind: "group" as const, ...ref, ownersCanAppointCoOwners: false };
      if (!manager && !permits(actor, "group.activities.manage", group)) {
        throw new DomainError("group_not_managed");
      }
      if (needs.shifts && !permits(actor, "group.duties.manage", group)) {
        throw new DomainError("group_not_managed");
      }
    }
    if (needs.event && !permits(actor, "club.events.create", { kind: "club", clubId })) {
      throw new DomainError("not_allowed");
    }
    return needs;
  }
}

function toSummary(t: TemplateRow, canManage: boolean): ProgrammeTemplateSummary {
  return {
    id: t.id,
    groupId: t.groupId,
    name: t.name,
    description: t.description,
    dayCount: t.dayCount,
    itemCount: t.itemCount,
    hasEvent: t.eventSettings !== null,
    archived: t.archived,
    canManage,
  };
}

function toItem(i: StoredItem): ProgrammeTemplate["items"][number] {
  return i;
}

function summary(p: ProgrammeRow, names: ReadonlyMap<string, string>): ProgrammeSummary {
  return {
    id: p.id,
    title: p.title,
    edition: p.edition,
    templateId: p.templateId,
    eventId: p.eventId,
    firstDay: p.firstDay,
    lastDay: p.lastDay,
    groups: p.groupIds.flatMap((id) => {
      const name = names.get(id);
      return name ? [{ id, name }] : [];
    }),
  };
}

function toPreview(result: {
  layout: Layout;
  title: string;
  edition: string | null;
  timeZone: string;
  snapshot: { eventSettings: { title: string; audience: "groups" | "club" } | null };
}): ProgrammePreview {
  const { layout } = result;
  return {
    title: result.title,
    edition: result.edition,
    firstDay: layout.firstDay,
    lastDay: layout.lastDay,
    timeZone: result.timeZone,
    items: layout.items.map((i) => ({
      itemId: i.itemId,
      kind: i.kind,
      parentItemId: i.parentItemId,
      title: i.title,
      activityKind: i.activityKind,
      kindLabel: i.kindLabel,
      startsAt: i.startsAt.toISOString(),
      endsAt: i.endsAt.toISOString(),
      groupIds: i.groupIds,
      locationId: i.locationId,
      locationText: i.locationText,
      dutyTypeId: i.dutyTypeId,
      needed: i.needed,
    })),
    slots: layout.slots,
    event: result.snapshot.eventSettings
      ? {
          title: result.snapshot.eventSettings.title,
          audience: result.snapshot.eventSettings.audience,
        }
      : null,
    warnings: layout.warnings,
    refusals: layout.refusals,
  };
}
