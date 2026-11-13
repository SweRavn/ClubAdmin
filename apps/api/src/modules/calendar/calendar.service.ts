// SPDX-License-Identifier: AGPL-3.0-only
// Calendar subscriptions (P1.11, ADR 0021, ADR 0044). A feed is a secret URL
// owned by a person; fetching it acts as the owner with their *current*
// rights, read-only, and shows exactly what they would see: "My schedule"
// (the same statement as the app), a group's calendar or the club's. Events
// name no one but the owner's own family, and carry answer links for the
// people the owner may answer for; a link answers through the same service
// as the app, after a confirmation (GET never changes anything).

import { createHash, randomBytes } from "node:crypto";

import { audit, type Database, outbox } from "@clubadmin/db";
import { type Locale, localeOf } from "@clubadmin/i18n";
import { calendarAnswerToken, parseCalendarAnswerToken } from "@clubadmin/server-kit/calendar";
import { message } from "@clubadmin/server-kit/notifications";
import {
  CALENDAR_FEEDS_MAX,
  type CalendarFeedScope,
  type CreateMyScheduleFeedInput,
  type IcalEvent,
  type PersonSummary,
  type UpdateCalendarFeedInput,
  writeCalendar,
} from "@clubadmin/shared";

import { DomainError } from "../../platform/domain/domain-error.ts";
import type { RateLimiter } from "../../platform/http/rate-limiter.ts";
import type { AccountsService } from "../accounts/index.ts";
import {
  type ActivitiesService,
  answerState,
  type AttendanceService,
  respondablePeopleOf,
  schedulePeopleOf,
  type ScheduleRow,
} from "../activities/index.ts";
import {
  type AuthorizationService,
  permits,
  type PersonPresenter,
  type RequestAuthorization,
  tenantContext,
} from "../authorization/index.ts";
import type { ClubsService } from "../clubs/index.ts";
import type { EntitlementsService } from "../entitlements/index.ts";
import type { GroupsService } from "../groups/index.ts";
import type { PeopleService } from "../people/index.ts";
import * as repo from "./calendar.repository.ts";
import { shownName } from "./presenters/shown-name.presenter.ts";

const DAY = 86_400_000;
/** Feeds cover 30 days back and 370 ahead (the schedule's 400-day range). */
const BACK_DAYS = 30;
const AHEAD_DAYS = 370;
const MAX_EVENTS = 3000;
/** A group or club feed without access is revoked after this long. */
const ACCESS_LOST_DAYS = 30;
const CACHE_SECONDS = 60;

const FEED_LIMIT = { name: "calendar_feed", max: 60, windowMs: 60_000 };
const UNKNOWN_FEED_LIMIT = { name: "calendar_feed_unknown", max: 150, windowMs: 60_000 };
const ANSWER_TOKEN_LIMIT = { name: "calendar_answer", max: 10, windowMs: 60_000 };

export type FeedView = repo.FeedRow & {
  club: { id: string; name: string } | null;
  group: { id: string; name: string } | null;
  people: PersonSummary[];
};

export interface FeedResult {
  status: 200 | 304 | 404;
  body?: string;
  etag?: string;
  lastModified?: Date;
}

/** Cache of rendered feeds (Valkey, decision 9); absent in tests without Valkey. */
export interface FeedCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, seconds: number): Promise<void>;
}

type AnswerStatus = "attending" | "not_attending";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export class CalendarService {
  private readonly db: Database;
  private readonly d: {
    activities: ActivitiesService;
    attendance: AttendanceService;
    authorization: AuthorizationService;
    people: PeopleService;
    presenter: PersonPresenter;
    entitlements: EntitlementsService;
    clubs: ClubsService;
    groups: GroupsService;
    accounts: AccountsService;
    limiter: RateLimiter;
    cache: FeedCache | null;
  };
  private readonly tokenKey: string | undefined;
  private readonly webUrl: string;
  private readonly version: string;
  private readonly cacheSeconds: number;
  private readonly now: () => Date;

  constructor(
    db: Database,
    deps: CalendarService["d"],
    options: {
      tokenKey: string | undefined;
      webUrl: string;
      version: string;
      cacheSeconds?: number;
      now?: () => Date;
    },
  ) {
    this.db = db;
    this.d = deps;
    this.tokenKey = options.tokenKey;
    this.webUrl = options.webUrl.replace(/\/$/, "");
    this.version = options.version;
    this.cacheSeconds = options.cacheSeconds ?? CACHE_SECONDS;
    this.now = options.now ?? (() => new Date());
  }

  /** Feeds are offered: the installation has them on and a key signs answer links. */
  get available(): boolean {
    return this.d.entitlements.isEnabled("calendar_feeds") && Boolean(this.tokenKey);
  }

  private requireAvailable(): void {
    if (!this.available) throw new DomainError("calendar_feeds_unavailable");
  }

  urls(secret: string): { webcalUrl: string; httpsUrl: string } {
    const httpsUrl = `${this.webUrl}/cal/${secret}.ics`;
    return { httpsUrl, webcalUrl: httpsUrl.replace(/^https?:\/\//, "webcal://") };
  }

  // --- Managing one's feeds ---------------------------------------------------------

  /** The caller's open feeds with the names of their group, club and people. */
  async list(authz: RequestAuthorization): Promise<FeedView[]> {
    const me = authz.principal.personId;
    const context = { ...authz.context, onBehalfOf: null };
    const { rows, clubNames } = await this.db.withActor(context, async (tx) => {
      const rows = await repo.openFeeds(tx, me);
      const clubs = await this.d.clubs.findClubsInTx(tx, [
        ...new Set(rows.flatMap((r) => (r.clubId ? [r.clubId] : []))),
      ]);
      return { rows, clubNames: new Map(clubs.map((c) => [c.id, c.name])) };
    });
    // Group names in their clubs (a person has few feeds, in fewer clubs).
    const groupNames = new Map<string, string>();
    for (const clubId of new Set(rows.flatMap((r) => (r.groupId && r.clubId ? [r.clubId] : [])))) {
      const ids = rows.filter((r) => r.clubId === clubId && r.groupId).map((r) => r.groupId!);
      for (const g of await this.d.groups.findGroups(tenantContext(authz, clubId), ids)) {
        groupNames.set(g.id, g.name);
      }
    }
    const people = await this.present(
      authz,
      rows.flatMap((r) => r.personIds),
    );
    return rows.map((r) => ({
      ...r,
      club: r.clubId ? { id: r.clubId, name: clubNames.get(r.clubId) ?? "" } : null,
      group: r.groupId ? { id: r.groupId, name: groupNames.get(r.groupId) ?? "" } : null,
      people: r.personIds.flatMap((id) => {
        const p = people.get(id);
        return p ? [p] : [];
      }),
    }));
  }

  private async present(
    authz: RequestAuthorization,
    ids: readonly string[],
  ): Promise<Map<string, PersonSummary>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.d.people.summaries(authz.context, unique);
    return new Map((await this.d.presenter.present(authz, null, rows)).map((p) => [p.id, p]));
  }

  /** A "My schedule" feed for the caller and chosen wards whose schedule they see. */
  createMySchedule(
    authz: RequestAuthorization,
    input: CreateMyScheduleFeedInput,
  ): Promise<{ feed: repo.FeedRow; secret: string }> {
    this.requireAvailable();
    if (authz.actor.onBehalfOf) throw new DomainError("not_allowed");
    const personIds = this.checkedPeople(authz, input.personIds);
    return this.create(authz, {
      scope: "my_schedule",
      clubId: null,
      groupId: null,
      personIds,
      label: input.label ?? null,
    });
  }

  /** A group's or club's feed (the controller checked the permission and the entitlement). */
  createScoped(
    authz: RequestAuthorization,
    target: { clubId: string; groupId: string | null },
    label: string | undefined,
  ): Promise<{ feed: repo.FeedRow; secret: string }> {
    this.requireAvailable();
    if (authz.actor.onBehalfOf) throw new DomainError("not_allowed");
    return this.create(authz, {
      scope: target.groupId ? "group" : "club",
      clubId: target.clubId,
      groupId: target.groupId,
      personIds: [],
      label: label ?? null,
    });
  }

  private checkedPeople(authz: RequestAuthorization, ids: readonly string[] | undefined): string[] {
    const allowed = schedulePeopleOf(authz.actor);
    const chosen = [...new Set(ids ?? [])];
    if (chosen.some((id) => !allowed.includes(id))) throw new DomainError("not_found");
    return chosen;
  }

  private create(
    authz: RequestAuthorization,
    values: {
      scope: CalendarFeedScope;
      clubId: string | null;
      groupId: string | null;
      personIds: string[];
      label: string | null;
    },
  ): Promise<{ feed: repo.FeedRow; secret: string }> {
    const me = authz.principal.personId;
    return this.db.withActor({ ...authz.context, onBehalfOf: null }, async (tx) => {
      if ((await repo.countOpen(tx, me)) >= CALENDAR_FEEDS_MAX) {
        throw new DomainError("too_many_feeds");
      }
      const secret = randomBytes(32).toString("base64url");
      const feed = await repo.insertFeed(tx, {
        ...values,
        personId: me,
        tokenHash: sha256(secret),
      });
      await audit.record(tx, {
        action: "calendar_feed.created",
        resourceType: "calendar_feed",
        resourceId: feed.id,
        changedFields: [
          "scope",
          ...(values.personIds.length ? ["person_ids"] : []),
          ...(values.label ? ["label"] : []),
        ],
      });
      return { feed, secret };
    });
  }

  update(
    authz: RequestAuthorization,
    feedId: string,
    input: UpdateCalendarFeedInput,
  ): Promise<repo.FeedRow> {
    const me = authz.principal.personId;
    return this.db.withActor({ ...authz.context, onBehalfOf: null }, async (tx) => {
      const feed = await repo.lockOwnFeed(tx, feedId, me);
      if (!feed) throw new DomainError("not_found");
      const patch: { label?: string | null; personIds?: string[] } = {};
      if (input.label !== undefined) patch.label = input.label;
      if (input.personIds !== undefined) {
        if (feed.scope !== "my_schedule") throw new DomainError("feed_scope_invalid");
        patch.personIds = this.checkedPeople(authz, input.personIds);
      }
      const changed = Object.keys(patch).map((k) => (k === "personIds" ? "person_ids" : k));
      if (changed.length === 0) return feed;
      const row = await repo.updateFeed(tx, feed.id, patch);
      await audit.record(tx, {
        action: "calendar_feed.updated",
        resourceType: "calendar_feed",
        resourceId: feed.id,
        changedFields: changed,
      });
      return row;
    });
  }

  /** Revokes the feed and creates one with the same settings and a new secret. */
  regenerate(
    authz: RequestAuthorization,
    feedId: string,
  ): Promise<{ feed: repo.FeedRow; secret: string }> {
    this.requireAvailable();
    const me = authz.principal.personId;
    return this.db.withActor({ ...authz.context, onBehalfOf: null }, async (tx) => {
      const old = await repo.lockOwnFeed(tx, feedId, me);
      if (!old) throw new DomainError("not_found");
      await repo.revokeFeed(tx, old.id, "regenerated");
      const secret = randomBytes(32).toString("base64url");
      const feed = await repo.insertFeed(tx, {
        personId: me,
        scope: old.scope,
        clubId: old.clubId,
        groupId: old.groupId,
        personIds: old.personIds,
        label: old.label,
        tokenHash: sha256(secret),
      });
      await audit.record(tx, {
        action: "calendar_feed.regenerated",
        resourceType: "calendar_feed",
        resourceId: feed.id,
        changedFields: ["token_hash"],
      });
      await audit.record(tx, {
        action: "calendar_feed.revoked",
        resourceType: "calendar_feed",
        resourceId: old.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
      return { feed, secret };
    });
  }

  revoke(authz: RequestAuthorization, feedId: string): Promise<void> {
    const me = authz.principal.personId;
    return this.db.withActor({ ...authz.context, onBehalfOf: null }, async (tx) => {
      const feed = await repo.lockOwnFeed(tx, feedId, me);
      if (!feed) throw new DomainError("not_found");
      await repo.revokeFeed(tx, feed.id, "owner");
      await audit.record(tx, {
        action: "calendar_feed.revoked",
        resourceType: "calendar_feed",
        resourceId: feed.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
    });
  }

  // --- Fetching a feed ----------------------------------------------------------------

  /**
   * The feed of a secret as iCalendar text, acting as its owner. Unknown,
   * revoked and switched-off feeds answer 404; `ifNoneMatch` gives 304.
   */
  async fetch(
    secret: string,
    ip: string,
    ifNoneMatch: string | undefined,
    requestId: string,
  ): Promise<FeedResult> {
    if (!this.available || !/^[A-Za-z0-9_-]{12,100}$/.test(secret)) return { status: 404 };
    const found = await this.db.withActor({ actorKind: "anonymous", requestId }, (tx) =>
      repo.findByTokenHash(tx, sha256(secret)),
    );
    if (!found) {
      // Guessing secrets costs the IP double.
      await this.d.limiter.enforce(UNKNOWN_FEED_LIMIT, ip);
      await this.d.limiter.enforce(UNKNOWN_FEED_LIMIT, ip);
      return { status: 404 };
    }
    await this.d.limiter.enforce(FEED_LIMIT, found.id);
    const cacheKey = `calendar:feed:${found.id}`;
    let cached = this.d.cache ? await this.d.cache.get(cacheKey) : null;
    if (!cached) {
      const body = await this.render(found, requestId);
      cached = JSON.stringify({
        body,
        // DTSTAMP is the time of rendering (METHOD:PUBLISH): leave it out of
        // the ETag, so the same content answers 304 even when rendered again.
        etag: `"${createHash("sha256")
          .update(body.replace(/^DTSTAMP:[^\r\n]*\r?\n/gm, ""))
          .digest("base64url")
          .slice(0, 32)}"`,
        at: this.now().toISOString(),
      });
      await this.d.cache?.set(cacheKey, cached, this.cacheSeconds);
    }
    const { body, etag, at } = JSON.parse(cached) as { body: string; etag: string; at: string };
    if (!found.lastFetchedAt || this.now().getTime() - found.lastFetchedAt.getTime() > 3_600_000) {
      await this.db.withActor({ actorKind: "person", personId: found.personId, requestId }, (tx) =>
        repo.touchFetched(tx, found.id),
      );
    }
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
      return { status: 304, etag };
    }
    return { status: 200, body, etag, lastModified: new Date(at) };
  }

  private async render(feed: repo.FoundFeed, requestId: string): Promise<string> {
    const authz = await this.d.authorization.forPerson(feed.personId, requestId);
    const prefs = await this.d.accounts.getPreferences(authz.context);
    const now = this.now();
    const from = new Date(now.getTime() - BACK_DAYS * DAY);
    const to = new Date(now.getTime() + AHEAD_DAYS * DAY);
    if (feed.scope === "my_schedule") {
      return this.renderMySchedule(authz, feed, prefs.locale, { from, to });
    }
    return this.renderScoped(authz, feed, prefs.locale, { from, to });
  }

  private locale(preferred: string | null, clubLocale: string | null | undefined): Locale {
    return localeOf(preferred) ?? localeOf(clubLocale ?? null) ?? "en";
  }

  private async renderMySchedule(
    authz: RequestAuthorization,
    feed: repo.FoundFeed,
    preferred: string | null,
    range: { from: Date; to: Date },
  ): Promise<string> {
    const visible = schedulePeopleOf(authz.actor);
    // Chosen people the owner may no longer see drop out at once.
    const people = feed.personIds.length
      ? feed.personIds.filter((id) => visible.includes(id))
      : visible;
    const data = await this.d.activities.scheduleForFeed(authz.context, {
      personIds: people,
      ...range,
      limit: MAX_EVENTS,
    });
    const entitled = new Map<string, boolean>();
    for (const clubId of data.clubs.keys()) {
      entitled.set(clubId, await this.d.entitlements.has(clubId, "calendar_feeds"));
    }
    const rows = data.items.filter((r) => entitled.get(r.clubId));
    const firstClub = rows[0] ? data.clubs.get(rows[0].clubId) : undefined;
    const locale = this.locale(preferred, null);
    const names = await this.present(authz, people);
    const respondable = respondablePeopleOf(authz.actor);
    const me = authz.actor.personId;
    const events = rows.map((r) => {
      const club = data.clubs.get(r.clubId) ?? { name: "", timeZone: "UTC" };
      const wards = r.personIds
        .filter((id) => id !== me)
        .flatMap((id) => {
          const p = names.get(id);
          return p ? [shownName(p)] : [];
        });
      const answerers = r.memberIds.filter((id) => respondable.includes(id) && names.has(id));
      return this.event(locale, r, {
        timeZone: club.timeZone,
        prefix: wards.join(", "),
        groups: r.groupIds.map((g) => data.groups.get(g) ?? "").filter(Boolean),
        answerers: answerers.map((id) => ({
          id,
          name: shownName(names.get(id)!),
          answer: r.answers[id] ?? null,
        })),
        feedId: feed.id,
        calloutOnly: false,
      });
    });
    return writeCalendar({
      prodId: `-//ClubAdmin//${this.version}//EN`,
      name: message(locale, "calendar.feed.mySchedule", {}),
      timeZone: firstClub?.timeZone ?? "Europe/Stockholm",
      events,
    });
  }

  private async renderScoped(
    authz: RequestAuthorization,
    feed: repo.FoundFeed,
    preferred: string | null,
    range: { from: Date; to: Date },
  ): Promise<string> {
    const clubId = feed.clubId!;
    const context = tenantContext(authz, clubId);
    const [club] = await this.db.withActor(authz.context, (tx) =>
      this.d.clubs.findClubsInTx(tx, [clubId]),
    );
    const locale = this.locale(preferred, club?.defaultLocale);
    const timeZone = club?.timeZone ?? "Europe/Stockholm";
    let allowed = await this.d.entitlements.has(clubId, "calendar_feeds");
    let groupName = "";
    if (allowed && feed.groupId) {
      const group = await this.d.authorization.groupResourceOf(authz.context, feed.groupId);
      allowed = group !== null && permits(authz.actor, "group.activities.read", group);
    } else if (allowed) {
      allowed = permits(authz.actor, "club.activities.read", { kind: "club", clubId });
    }
    if (!allowed) {
      await this.accessLost(feed, authz);
      return writeCalendar({
        prodId: `-//ClubAdmin//${this.version}//EN`,
        name: club?.name ?? "ClubAdmin",
        description: message(locale, "calendar.feed.noAccess", {}),
        timeZone,
        events: [],
      });
    }
    if (feed.accessLostAt) {
      await this.db.withActor(authz.context, (tx) =>
        repo.updateFeed(tx, feed.id, { accessLostAt: null }),
      );
    }
    const target = feed.groupId ? { groupId: feed.groupId } : { clubId };
    const data = await this.d.activities.feedEntries(context, target, {
      ...range,
      limit: MAX_EVENTS,
    });
    if (feed.groupId) groupName = data.groups.get(feed.groupId) ?? "";
    // Answer links in a group feed: the owner's own family on the roster
    // (decision 4), through their schedule in this club; none in club feeds.
    const family = new Map<string, ScheduleRow>();
    let names = new Map<string, PersonSummary>();
    if (feed.groupId) {
      const respondable = respondablePeopleOf(authz.actor);
      const mine = await this.d.activities.scheduleForFeed(authz.context, {
        personIds: respondable,
        ...range,
        limit: MAX_EVENTS,
      });
      for (const r of mine.items) family.set(r.activityId, r);
      names = await this.present(authz, respondable);
    }
    const events = data.items.map((r) => {
      const own = family.get(r.activityId);
      const answerers = own
        ? own.memberIds
            .filter((id) => names.has(id))
            .map((id) => ({
              id,
              name: shownName(names.get(id)!),
              answer: own.answers[id] ?? null,
            }))
        : [];
      return this.event(locale, r, {
        timeZone,
        prefix: "",
        groups: r.groupIds.map((g) => data.groups.get(g) ?? "").filter(Boolean),
        answerers,
        feedId: feed.id,
        calloutOnly: r.inviteesOnly,
      });
    });
    return writeCalendar({
      prodId: `-//ClubAdmin//${this.version}//EN`,
      name: groupName ? `${club?.name ?? ""} – ${groupName}` : (club?.name ?? "ClubAdmin"),
      timeZone,
      events,
    });
  }

  /** Marks a group or club feed without access, and revokes it after 30 days of that. */
  private async accessLost(feed: repo.FoundFeed, authz: RequestAuthorization): Promise<void> {
    const now = this.now();
    if (!feed.accessLostAt) {
      await this.db.withActor(authz.context, (tx) =>
        repo.updateFeed(tx, feed.id, { accessLostAt: now }),
      );
      return;
    }
    if (now.getTime() - feed.accessLostAt.getTime() < ACCESS_LOST_DAYS * DAY) return;
    await this.db.withSystem("calendar:access_lost", {}, async (tx) => {
      await repo.revokeFeed(tx, feed.id, "access_lost");
      await audit.record(tx, {
        action: "calendar_feed.revoked",
        resourceType: "calendar_feed",
        resourceId: feed.id,
        changedFields: ["revoked_at", "revoked_reason"],
      });
      await outbox.publish(tx, "calendar.feed.revoked", {
        feedId: feed.id,
        personId: feed.personId,
      });
    });
  }

  private event(
    locale: Locale,
    r: ScheduleRow,
    o: {
      timeZone: string;
      prefix: string;
      groups: string[];
      answerers: { id: string; name: string; answer: string | null }[];
      feedId: string;
      calloutOnly: boolean;
    },
  ): IcalEvent {
    const cancelled = r.status === "cancelled";
    const time = (d: Date) =>
      new Intl.DateTimeFormat(locale, {
        timeZone: o.timeZone,
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    const when = (d: Date) =>
      new Intl.DateTimeFormat(locale, {
        timeZone: o.timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    const t = (key: string, values: Record<string, string> = {}) =>
      message(locale, `calendar.feed.${key}`, values);
    const title = r.kindLabel && !r.title ? r.kindLabel : r.title;
    const summary = `${cancelled ? t("cancelledPrefix") : ""}${o.prefix ? `${o.prefix}: ` : ""}${title}`;
    const lines: string[] = [];
    if (o.groups.length) lines.push(t("groups", { groups: o.groups.join(", ") }));
    if (r.meetAt) {
      lines.push(
        r.meetPlace
          ? t("meetAt", { time: time(r.meetAt), place: r.meetPlace })
          : t("meet", { time: time(r.meetAt) }),
      );
    }
    if (cancelled && r.cancelledReason)
      lines.push(t("cancelledReason", { reason: r.cancelledReason }));
    if (o.calloutOnly) lines.push(t("calloutOnly"));
    const state = answerState(r, this.now());
    for (const p of o.answerers) {
      lines.push(
        p.answer === "attending"
          ? t("isComing", { name: p.name })
          : p.answer === "not_attending"
            ? t("isNotComing", { name: p.name })
            : t("noAnswer", { name: p.name }),
      );
      if (state.open && this.tokenKey) {
        if (!state.deadlinePassed) {
          lines.push(
            t("linkComing", {
              name: p.name,
              url: this.answerUrl(o.feedId, r.activityId, p.id, "attending"),
            }),
          );
        }
        lines.push(
          t("linkNotComing", {
            name: p.name,
            url: this.answerUrl(o.feedId, r.activityId, p.id, "not_attending"),
          }),
        );
      }
    }
    if (o.answerers.length && state.open && r.respondBy) {
      lines.push(t("answerBy", { deadline: when(r.respondBy) }));
    }
    lines.push("", t("footer", { url: `${this.webUrl}/me/calendar` }));
    const location = [r.place, r.address].filter(Boolean).join(", ");
    return {
      uid: `${r.activityId}@${new URL(this.webUrl).hostname}`,
      stamp: this.now(),
      start: r.startsAt,
      end: r.endsAt,
      allDay: r.allDay,
      timeZone: o.timeZone,
      sequence: r.sequence,
      lastModified: r.changedAt,
      cancelled,
      summary,
      location: location || null,
      geo:
        r.latitude !== null && r.longitude !== null
          ? { latitude: r.latitude, longitude: r.longitude }
          : null,
      description: lines.join("\n"),
      url: `${this.webUrl}/activities/${r.activityId}`,
      categories: r.kind,
    };
  }

  // --- Answer links -------------------------------------------------------------------

  answerToken(feedId: string, activityId: string, personId: string, status: AnswerStatus): string {
    return calendarAnswerToken(this.tokenKey!, { feedId, activityId, personId, status });
  }

  private answerUrl(
    feedId: string,
    activityId: string,
    personId: string,
    status: AnswerStatus,
  ): string {
    return `${this.webUrl}/answer/${this.answerToken(feedId, activityId, personId, status)}`;
  }

  /** The link's parts if its signature holds, else answer_link_invalid. */
  private parseToken(token: string) {
    const link = this.tokenKey ? parseCalendarAnswerToken(this.tokenKey, token) : null;
    if (!link) throw new DomainError("answer_link_invalid");
    return link;
  }

  /**
   * What a link would answer, re-checked now: the feed is open, the owner
   * may still answer for the person, the activity is theirs and has not ended.
   */
  async answerInfo(token: string, ip: string, requestId: string) {
    await this.d.limiter.enforce(ANSWER_TOKEN_LIMIT, sha256(token).slice(0, 32));
    const link = this.parseToken(token);
    const feed = await this.db.withSystem("calendar:answer_link", {}, (tx) =>
      repo.findById(tx, link.feedId),
    );
    if (!feed) throw new DomainError("answer_link_invalid");
    if (feed.revokedAt) throw new DomainError("answer_link_expired");
    const authz = await this.d.authorization.forPerson(feed.personId, requestId);
    if (!respondablePeopleOf(authz.actor).includes(link.personId)) {
      throw new DomainError("answer_link_invalid");
    }
    const entry = await this.d.activities.scheduleEntryFor(
      authz.context,
      [link.personId],
      link.activityId,
    );
    if (!entry || !entry.row.memberIds.includes(link.personId)) {
      throw new DomainError("answer_link_invalid");
    }
    if (entry.row.endsAt.getTime() <= this.now().getTime()) {
      throw new DomainError("answer_link_expired");
    }
    const names = await this.present(authz, [link.personId]);
    const person = names.get(link.personId);
    if (!person) throw new DomainError("answer_link_invalid");
    void ip;
    return { link, authz, entry, person, state: answerState(entry.row, this.now()) };
  }

  /** Answers as the feed's owner (on behalf of the ward), through the attendance service. */
  async answer(
    token: string,
    ip: string,
    requestId: string,
  ): Promise<"attending" | "not_attending"> {
    const { link, authz, entry } = await this.answerInfo(token, ip, requestId);
    await this.d.attendance.respond(
      tenantContext(authz, entry.row.clubId),
      link.activityId,
      link.personId,
      { status: link.status },
      { via: "calendar_link" },
    );
    return link.status;
  }
}
