// SPDX-License-Identifier: AGPL-3.0-only
// Transactional email (P1.1, ADR 0032): invitations, decisions on join
// requests and club creation requests, and changes of a club's managers.
// The API publishes domain events with IDs only; this handler reads what the
// email needs, renders it from the ICU catalogues in the recipient's
// language and sends it through a MailProvider. Names of protected people
// are left out unless the recipient may see them (ADR 0022). Notification
// preferences, push and in-app messages come with P1.7.

import { type OutboxEvent, type OutboxHandler, sql, type Tx } from "@clubadmin/db";
import { type Catalogue, catalogues, DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";
import { emailInvitationToken, invitationUrl } from "@clubadmin/server-kit/invitations";
import { DOMAIN_EVENTS } from "@clubadmin/shared";
import { IntlMessageFormat } from "intl-messageformat";
import { createTransport } from "nodemailer";

import { nameFor, visibleName } from "./presenters/mail-names.ts";

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
    clubName: string,
  ) => {
    await options.provider.send({
      to: to.email,
      subject,
      text: `${body}\n\n-- \n${render(locale, "footer", { club: clubName })}\n`,
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
        default:
          return;
      }
    },
  };
}
