// SPDX-License-Identifier: AGPL-3.0-only
// Transactional email (P1.1, ADR 0032): invitations, decisions on join
// requests and club creation requests, and changes of a club's managers;
// families (P1.3): guardian invitations and their acceptance, own logins,
// the own-login age and the adult age; events (P1.6): a place offered or
// given from the waiting list.
// The API publishes domain events with IDs only; this handler reads what the
// email needs, renders it from the ICU catalogues in the recipient's
// language and sends it through a MailProvider. Names of protected people
// are left out unless the recipient may see them (ADR 0022). Notification
// preferences, push and in-app messages come with P1.7.

import { type OutboxEvent, type OutboxHandler, sql, type Tx } from "@clubadmin/db";
import { type Catalogue, catalogues, DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";
import {
  accountInvitationToken,
  accountInvitationUrl,
  emailInvitationToken,
  guardianInvitationToken,
  guardianInvitationUrl,
  invitationUrl,
} from "@clubadmin/server-kit/invitations";
import { DOMAIN_EVENTS } from "@clubadmin/shared";
import { IntlMessageFormat } from "intl-messageformat";
import { createTransport } from "nodemailer";

import { givenNameFor, nameFor, unprotectedNames, visibleName } from "./presenters/mail-names.ts";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable per event and recipient: a resent email keeps its Message-ID. */
  messageId: string;
}

export interface MailProvider {
  send(message: MailMessage): Promise<void>;
}

/** SMTP (Mailpit in development; any SMTP relay when self-hosting). */
export function smtpMailProvider(options: { url: string; from: string }): MailProvider {
  const transport = createTransport(options.url);
  const domain = options.from.split("@")[1] ?? "clubadmin.invalid";
  return {
    async send(message) {
      await transport.sendMail({
        from: options.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: `<${message.messageId}@${domain}>`,
      });
    },
  };
}

/** Collects messages instead of sending them (tests). */
export function memoryMailProvider(): MailProvider & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

type Values = Record<string, string>;

function lookup(catalogue: Catalogue, key: string): string | undefined {
  let node: string | Catalogue | undefined = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Renders a message of the email namespace (or another prefix); Norwegian falls back to English. */
export function render(locale: Locale, key: string, values: Values, namespace = "email."): string {
  const message =
    lookup(catalogues[locale], `${namespace}${key}`) ?? lookup(catalogues.en, `${namespace}${key}`);
  if (!message) throw new Error(`missing message ${namespace}${key}`);
  return String(new IntlMessageFormat(message, locale).format(values));
}

const pickLocale = (...tags: (string | null | undefined)[]): Locale =>
  tags.map(localeOf).find((l): l is Locale => l !== null) ?? DEFAULT_LOCALE;

interface Recipient {
  personId: string;
  email: string;
  locale: string | null;
}

type ClubRow = {
  name: string;
  default_locale: string;
};

const inClub = (tx: Tx, clubId: string) =>
  tx.execute(sql`SELECT set_config('app.club_id', ${clubId}, true)`);

async function club(tx: Tx, clubId: string): Promise<ClubRow | null> {
  const { rows } = await tx.execute<ClubRow>(
    sql`SELECT name, default_locale FROM public.clubs WHERE id = ${clubId}`,
  );
  return rows[0] ?? null;
}

async function recipients(tx: Tx, personIds: readonly string[]): Promise<Recipient[]> {
  if (personIds.length === 0) return [];
  const { rows } = await tx.execute<{
    person_id: string;
    email: string;
    locale: string | null;
  }>(sql`
    SELECT person_id, email, locale FROM public.accounts
    WHERE person_id = ANY (${`{${personIds.join(",")}}`}::uuid[]) AND email_verified_at IS NOT NULL`);
  return rows.map((r) => ({ personId: r.person_id, email: r.email, locale: r.locale }));
}

export interface MailHandlerOptions {
  provider: MailProvider;
  webUrl: string;
  /** INVITATION_TOKEN_KEY: without it invitation emails cannot carry a link. */
  invitationTokenKey: string | undefined;
}

export function mailHandler(options: MailHandlerOptions): OutboxHandler {
  const link = (path: string) => new URL(path, options.webUrl).toString();
  const send = async (
    event: OutboxEvent,
    to: Recipient,
    locale: Locale,
    subject: string,
    body: string,
    /** Null for emails that are not on behalf of a club (families). */
    clubName: string | null,
  ) => {
    const footer =
      clubName === null
        ? render(locale, "footerPlain", {})
        : render(locale, "footer", { club: clubName });
    await options.provider.send({
      to: to.email,
      subject,
      text: `${body}\n\n-- \n${footer}\n`,
      messageId: `${event.idempotencyKey}.${to.personId}`,
    });
  };

  return {
    name: "mail",
    types: [
      "invitation.created",
      "join_request.decided",
      "club.manager.changed",
      "club_creation_request.decided",
      "members.exported",
      "members.import.finished",
      "guardianship.invited",
      "guardianship.invitation.accepted",
      "account.invited",
      "guardianship.ward.own_login_age",
      "guardianship.ward.adult",
      "guardianship.adult.ended",
      "event.offer.made",
    ],
    async handle(event, tx) {
      switch (event.type) {
        case "invitation.created": {
          const { invitationId, clubId } = DOMAIN_EVENTS["invitation.created"].parse(event.payload);
          if (!options.invitationTokenKey) throw new Error("INVITATION_TOKEN_KEY is not set");
          await inClub(tx, clubId);
          const { rows } = await tx.execute<{
            email: string | null;
            expires_at: string;
            created_by_person_id: string;
            revoked_at: string | null;
          }>(sql`
            SELECT email, expires_at, created_by_person_id, revoked_at
            FROM public.invitations WHERE id = ${invitationId}`);
          const invitation = rows[0];
          const c = await club(tx, clubId);
          if (!invitation?.email || invitation.revoked_at || !c) return;
          const locale = pickLocale(c.default_locale);
          const inviter = await visibleName(tx, clubId, invitation.created_by_person_id);
          const url = invitationUrl(
            options.webUrl,
            emailInvitationToken(options.invitationTokenKey, invitationId),
          );
          const values = {
            club: c.name,
            inviter: inviter ?? "",
            hasInviter: inviter ? "yes" : "no",
            url,
            expires: new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(
              new Date(invitation.expires_at),
            ),
          };
          await send(
            event,
            { personId: invitationId, email: invitation.email, locale: null },
            locale,
            render(locale, "invitation.subject", values),
            render(locale, "invitation.body", values),
            c.name,
          );
          return;
        }
        case "join_request.decided": {
          const { joinRequestId, clubId } = DOMAIN_EVENTS["join_request.decided"].parse(
            event.payload,
          );
          await inClub(tx, clubId);
          const { rows } = await tx.execute<{
            person_id: string;
            requested_by_person_id: string;
            status: string;
            decision_message: string | null;
          }>(sql`
            SELECT person_id, requested_by_person_id, status, decision_message
            FROM public.join_requests WHERE id = ${joinRequestId}`);
          const request = rows[0];
          const c = await club(tx, clubId);
          if (!request || !c || (request.status !== "approved" && request.status !== "rejected")) {
            return;
          }
          const [to] = await recipients(tx, [request.requested_by_person_id]);
          if (!to) return;
          const locale = pickLocale(to.locale, c.default_locale);
          const values = {
            club: c.name,
            person: await nameFor(tx, request.person_id),
            hasMessage: request.decision_message ? "yes" : "no",
            message: request.decision_message ?? "",
            url: link("/"),
          };
          const kind = request.status === "approved" ? "approved" : "rejected";
          await send(
            event,
            to,
            locale,
            render(locale, `joinRequest.${kind}Subject`, values),
            render(locale, `joinRequest.${kind}Body`, values),
            c.name,
          );
          return;
        }
        case "club.manager.changed": {
          const { clubId, personId, change } = DOMAIN_EVENTS["club.manager.changed"].parse(
            event.payload,
          );
          await inClub(tx, clubId);
          const c = await club(tx, clubId);
          if (!c) return;
          const { rows } = await tx.execute<{ person_id: string }>(sql`
            SELECT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role = 'club_manager' AND valid_to IS NULL`);
          // Every manager hears about it, and so does the person who lost the role.
          const ids = [...new Set([...rows.map((r) => r.person_id), personId])];
          const person = await nameFor(tx, personId);
          for (const to of await recipients(tx, ids)) {
            const locale = pickLocale(to.locale, c.default_locale);
            const values = { club: c.name, person, change, url: link(`/clubs/${clubId}`) };
            await send(
              event,
              to,
              locale,
              render(locale, "managers.subject", values),
              render(locale, "managers.body", values),
              c.name,
            );
          }
          return;
        }
        case "club_creation_request.decided": {
          const { requestId } = DOMAIN_EVENTS["club_creation_request.decided"].parse(event.payload);
          const { rows } = await tx.execute<{
            requested_by_person_id: string;
            name: string;
            status: string;
            decision_message: string | null;
            created_club_id: string | null;
          }>(sql`
            SELECT requested_by_person_id, name, status, decision_message, created_club_id
            FROM public.club_creation_requests WHERE id = ${requestId}`);
          const request = rows[0];
          if (!request || (request.status !== "approved" && request.status !== "rejected")) return;
          const [to] = await recipients(tx, [request.requested_by_person_id]);
          if (!to) return;
          const locale = pickLocale(to.locale);
          const values = {
            club: request.name,
            hasMessage: request.decision_message ? "yes" : "no",
            message: request.decision_message ?? "",
            url: link(request.created_club_id ? `/clubs/${request.created_club_id}` : "/"),
          };
          const kind = request.status === "approved" ? "approved" : "rejected";
          await send(
            event,
            to,
            locale,
            render(locale, `clubCreation.${kind}Subject`, values),
            render(locale, `clubCreation.${kind}Body`, values),
            request.name,
          );
          return;
        }
        case "members.exported": {
          const { exportId, clubId } = DOMAIN_EVENTS["members.exported"].parse(event.payload);
          await inClub(tx, clubId);
          const { rows } = await tx.execute<{
            requested_by_person_id: string;
            columns: string[];
            include_protected: boolean;
          }>(sql`
            SELECT requested_by_person_id, columns, include_protected
            FROM public.member_exports WHERE id = ${exportId}`);
          const exported = rows[0];
          const c = await club(tx, clubId);
          if (!exported || !c) return;
          const { rows: managers } = await tx.execute<{ person_id: string }>(sql`
            SELECT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role = 'club_manager' AND valid_to IS NULL`);
          // Managers see protected people of their club (ADR 0022).
          const requester = await nameFor(tx, exported.requested_by_person_id);
          for (const to of await recipients(
            tx,
            managers.map((m) => m.person_id),
          )) {
            const locale = pickLocale(to.locale, c.default_locale);
            const columns = new Intl.ListFormat(locale, { type: "conjunction" }).format(
              exported.columns.map((column) =>
                render(locale, `memberExport.columns.${column}`, {}, ""),
              ),
            );
            const values = {
              club: c.name,
              requester,
              columns,
              includeProtected: exported.include_protected ? "yes" : "no",
              url: link(`/clubs/${clubId}/members/exports`),
            };
            await send(
              event,
              to,
              locale,
              render(locale, "membersExported.subject", values),
              render(locale, "membersExported.body", values),
              c.name,
            );
          }
          return;
        }
        case "members.import.finished": {
          const { importId, clubId } = DOMAIN_EVENTS["members.import.finished"].parse(
            event.payload,
          );
          await inClub(tx, clubId);
          const { rows } = await tx.execute<{
            created_by_person_id: string;
            confirmed_by_person_id: string | null;
            status: string;
            counts: { imported: number; skipped: number; error: number; invitations: number };
          }>(sql`
            SELECT created_by_person_id, confirmed_by_person_id, status, counts
            FROM public.member_imports WHERE id = ${importId}`);
          const imported = rows[0];
          const c = await club(tx, clubId);
          if (!imported || !c) return;
          const { rows: managers } = await tx.execute<{ person_id: string }>(sql`
            SELECT person_id FROM public.club_role_assignments
            WHERE club_id = ${clubId} AND role = 'club_manager' AND valid_to IS NULL`);
          // Managers see protected people of their club (ADR 0022). Counts only, never rows.
          const importer = await nameFor(
            tx,
            imported.confirmed_by_person_id ?? imported.created_by_person_id,
          );
          for (const to of await recipients(
            tx,
            managers.map((m) => m.person_id),
          )) {
            const locale = pickLocale(to.locale, c.default_locale);
            const values = {
              club: c.name,
              importer,
              status: imported.status === "done" ? "done" : "failed",
              imported: String(imported.counts.imported),
              skipped: String(imported.counts.skipped),
              errors: String(imported.counts.error),
              invitations: String(imported.counts.invitations),
              hasInvitations: imported.counts.invitations > 0 ? "yes" : "no",
              url: link(`/clubs/${clubId}/members/import?import=${importId}`),
            };
            await send(
              event,
              to,
              locale,
              render(locale, "membersImportFinished.subject", values),
              render(locale, "membersImportFinished.body", values),
              c.name,
            );
          }
          return;
        }
        case "event.offer.made": {
          const { clubId, eventId, registrationId, personId, kind } = DOMAIN_EVENTS[
            "event.offer.made"
          ].parse(event.payload);
          await inClub(tx, clubId);
          const { rows } = await tx.execute<{
            title: string;
            starts_at: string;
            status: string;
            offer_expires_at: string | null;
            time_zone: string;
          }>(sql`
            SELECT e.title, e.starts_at, r.status, r.offer_expires_at, c.time_zone
            FROM public.event_registrations r
            JOIN public.events e ON e.id = r.event_id
            JOIN public.clubs c ON c.id = e.club_id
            WHERE r.id = ${registrationId} AND e.id = ${eventId}`);
          const reg = rows[0];
          const c = await club(tx, clubId);
          // Answered, expired or removed meanwhile: nothing to tell.
          if (!reg || !c || reg.status !== kind) return;
          // The participant and guardians with receive_messages; never other participants.
          const { rows: guardians } = await tx.execute<{ guardian_person_id: string }>(sql`
            SELECT guardian_person_id FROM public.guardianships
            WHERE ward_person_id = ${personId} AND valid_to IS NULL
              AND 'receive_messages' = ANY (rights)`);
          const person = await nameFor(tx, personId);
          for (const to of await recipients(tx, [
            personId,
            ...guardians.map((g) => g.guardian_person_id),
          ])) {
            const locale = pickLocale(to.locale, c.default_locale);
            const at = (value: string, style: "date" | "time") =>
              new Intl.DateTimeFormat(locale, {
                dateStyle: "long",
                ...(style === "time" ? { timeStyle: "short" } : {}),
                timeZone: reg.time_zone,
              }).format(new Date(value));
            const values = {
              club: c.name,
              event: reg.title,
              person,
              date: at(reg.starts_at, "date"),
              deadline: reg.offer_expires_at ? at(reg.offer_expires_at, "time") : "",
              url: link(`/events/${eventId}`),
            };
            await send(
              event,
              to,
              locale,
              render(locale, `eventOffer.${kind}Subject`, values),
              render(locale, `eventOffer.${kind}Body`, values),
              c.name,
            );
          }
          return;
        }
        case "guardianship.invited":
        case "guardianship.invitation.accepted":
        case "account.invited":
        case "guardianship.ward.own_login_age":
        case "guardianship.ward.adult":
        case "guardianship.adult.ended":
          return familyMail(event, tx);
        default:
          return;
      }
    },
  };

  /** Family emails (P1.3): not on behalf of a club; names only for those who may see them. */
  async function familyMail(event: OutboxEvent, tx: Tx): Promise<void> {
    const date = (locale: Locale, value: string | Date) =>
      new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(value));
    const mail = async (to: Recipient, locale: Locale, key: string, values: Values) =>
      send(
        event,
        to,
        locale,
        render(locale, `family.${key}Subject`, values),
        render(locale, `family.${key}Body`, values),
        null,
      );
    // The person's language, else their clubs' (club_memberships system_read), else English.
    const localeOfPerson = async (personId: string): Promise<Locale> => {
      const { rows } = await tx.execute<{ locale: string | null }>(sql`
        SELECT a.locale FROM public.accounts a WHERE a.person_id = ${personId}
        UNION ALL
        SELECT c.default_locale FROM public.club_memberships m JOIN public.clubs c ON c.id = m.club_id
        WHERE m.person_id = ${personId} AND m.valid_to IS NULL`);
      return pickLocale(...rows.map((r) => r.locale));
    };
    const guardianship = async (id: string) => {
      const { rows } = await tx.execute<{
        guardian_person_id: string;
        ward_person_id: string;
        kind: string;
        open: boolean;
      }>(sql`
        SELECT guardian_person_id, ward_person_id, kind, valid_to IS NULL AS open
        FROM public.guardianships WHERE id = ${id}`);
      return rows[0] ?? null;
    };

    switch (event.type) {
      case "guardianship.invited": {
        const { invitationId } = DOMAIN_EVENTS["guardianship.invited"].parse(event.payload);
        if (!options.invitationTokenKey) throw new Error("INVITATION_TOKEN_KEY is not set");
        const { rows } = await tx.execute<{
          email: string;
          kind: string;
          ward_person_id: string;
          invited_by_person_id: string;
          expires_at: string;
          resent_at: Date | null;
          pending: boolean;
          club_id: string | null;
        }>(sql`
          SELECT email, kind, ward_person_id, invited_by_person_id, expires_at, resent_at,
            accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() AS pending, club_id
          FROM public.guardian_invitations WHERE id = ${invitationId}`);
        const invitation = rows[0];
        if (!invitation?.pending) return;
        if (invitation.club_id) {
          // Sent by a club (P1.3b): the email names the club and why; the
          // child's name only if protected neither globally nor in the club.
          await inClub(tx, invitation.club_id);
          const c = await club(tx, invitation.club_id);
          if (!c) return;
          const { rows: profiles } = await tx.execute<{ protected: boolean }>(sql`
            SELECT protected_identity_club AS protected FROM public.club_profiles
            WHERE club_id = ${invitation.club_id} AND person_id = ${invitation.ward_person_id}`);
          const ward = profiles[0]?.protected
            ? null
            : await unprotectedNames(tx, invitation.ward_person_id);
          const locale = pickLocale(c.default_locale);
          const token = guardianInvitationToken(
            options.invitationTokenKey,
            invitationId,
            invitation.resent_at ? new Date(invitation.resent_at) : null,
          );
          await send(
            event,
            { personId: invitationId, email: invitation.email, locale: null },
            locale,
            render(locale, "family.clubInvitationSubject", { club: c.name }),
            render(locale, "family.clubInvitationBody", {
              club: c.name,
              kind: invitation.kind,
              hasWard: ward ? "yes" : "no",
              ward: ward?.first ?? "",
              url: guardianInvitationUrl(options.webUrl, token),
              expires: date(locale, invitation.expires_at),
            }),
            c.name,
          );
          return;
        }
        const locale = await localeOfPerson(invitation.invited_by_person_id);
        // The invitee is not family yet: no names of protected people.
        const [ward, inviter] = await Promise.all([
          unprotectedNames(tx, invitation.ward_person_id),
          unprotectedNames(tx, invitation.invited_by_person_id),
        ]);
        const token = guardianInvitationToken(
          options.invitationTokenKey,
          invitationId,
          invitation.resent_at ? new Date(invitation.resent_at) : null,
        );
        // A resend is a new event: a new email with the new link.
        await mail(
          { personId: invitationId, email: invitation.email, locale: null },
          locale,
          "invitation",
          {
            kind: invitation.kind,
            hasInviter: inviter ? "yes" : "no",
            inviter: inviter?.name ?? "",
            hasWard: ward ? "yes" : "no",
            ward: ward?.first ?? "",
            url: guardianInvitationUrl(options.webUrl, token),
            expires: date(locale, invitation.expires_at),
          },
        );
        return;
      }
      case "guardianship.invitation.accepted": {
        const { invitationId } = DOMAIN_EVENTS["guardianship.invitation.accepted"].parse(
          event.payload,
        );
        const { rows } = await tx.execute<{
          invited_by_person_id: string;
          accepted_by_person_id: string | null;
          ward_person_id: string;
          kind: string;
        }>(sql`
          SELECT invited_by_person_id, accepted_by_person_id, ward_person_id, kind
          FROM public.guardian_invitations WHERE id = ${invitationId}`);
        const invitation = rows[0];
        if (!invitation?.accepted_by_person_id) return;
        const [to] = await recipients(tx, [invitation.invited_by_person_id]);
        if (!to) return;
        const locale = await localeOfPerson(to.personId);
        // The inviter is family of both (the ward, and now a co-guardian or the ward's helper).
        await mail(to, locale, "accepted", {
          person: await nameFor(tx, invitation.accepted_by_person_id),
          ward: await nameFor(tx, invitation.ward_person_id),
          kind: invitation.kind,
          url: link("/me/family"),
        });
        return;
      }
      case "account.invited": {
        const { invitationId, personId } = DOMAIN_EVENTS["account.invited"].parse(event.payload);
        if (!options.invitationTokenKey) throw new Error("INVITATION_TOKEN_KEY is not set");
        const { rows } = await tx.execute<{
          email: string;
          created_by_person_id: string;
          expires_at: string;
          pending: boolean;
        }>(sql`
          SELECT email, created_by_person_id, expires_at,
            accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() AS pending
          FROM public.account_invitations WHERE id = ${invitationId}`);
        const invitation = rows[0];
        if (!invitation?.pending) return;
        const locale = await localeOfPerson(invitation.created_by_person_id);
        await mail({ personId, email: invitation.email, locale: null }, locale, "ownLogin", {
          name: await givenNameFor(tx, personId),
          url: accountInvitationUrl(
            options.webUrl,
            accountInvitationToken(options.invitationTokenKey, invitationId),
          ),
          expires: date(locale, invitation.expires_at),
        });
        return;
      }
      case "guardianship.ward.own_login_age": {
        const { guardianshipId } = DOMAIN_EVENTS["guardianship.ward.own_login_age"].parse(
          event.payload,
        );
        const g = await guardianship(guardianshipId);
        if (!g?.open) return;
        const [to] = await recipients(tx, [g.guardian_person_id]);
        if (!to) return;
        await mail(to, await localeOfPerson(to.personId), "ownLoginAge", {
          ward: await nameFor(tx, g.ward_person_id),
          url: link("/me/family"),
        });
        return;
      }
      case "guardianship.ward.adult": {
        const { guardianshipId, wardPersonId } = DOMAIN_EVENTS["guardianship.ward.adult"].parse(
          event.payload,
        );
        const g = await guardianship(guardianshipId);
        if (!g?.open) return;
        const [young] = await recipients(tx, [wardPersonId]);
        if (young) {
          // One email to the young person, for the first of their flagged guardianships.
          const { rows } = await tx.execute<{ id: string }>(sql`
            SELECT id FROM public.guardianships
            WHERE ward_person_id = ${wardPersonId} AND ward_adult_flagged_at IS NOT NULL
            ORDER BY id LIMIT 1`);
          if (rows[0]?.id !== guardianshipId) return;
          await mail(young, await localeOfPerson(young.personId), "adultYoung", {
            url: link("/me/family/adult"),
          });
          return;
        }
        const [to] = await recipients(tx, [g.guardian_person_id]);
        if (!to) return;
        await mail(to, await localeOfPerson(to.personId), "adultGuardian", {
          ward: await nameFor(tx, wardPersonId),
          url: link("/me/family"),
        });
        return;
      }
      case "guardianship.adult.ended": {
        const { guardianshipId, wardPersonId } = DOMAIN_EVENTS["guardianship.adult.ended"].parse(
          event.payload,
        );
        const g = await guardianship(guardianshipId);
        if (!g || g.open) return;
        const [to] = await recipients(tx, [g.guardian_person_id]);
        if (!to) return;
        // No longer family: the name only if the young person is not protected; never why.
        const ward = await unprotectedNames(tx, wardPersonId);
        await mail(to, await localeOfPerson(to.personId), "adultEnded", {
          hasWard: ward ? "yes" : "no",
          ward: ward?.name ?? "",
          kind: g.kind,
          url: link("/"),
        });
        return;
      }
      default:
        return;
    }
  }
}
