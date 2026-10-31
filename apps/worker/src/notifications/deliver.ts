// SPDX-License-Identifier: AGPL-3.0-only
// Delivering notices (P1.7, ADR 0039), `notifications:deliver`: woken when
// notices are created and run every minute by the crontab.
// - Push: due deliveries in batches of 100 (Expo's limit). A push held for
//   quiet hours is dropped when the notice was read or what it is about
//   has started; at most NOTIFY_PUSH_PER_PERSON_HOUR per person, beyond
//   that only the inbox has it. DeviceNotRegistered disables the device.
// - Email sent at once: one email per delivery, rendered now in the
//   recipient's language (moved types by their original email code).
// - The daily email: per recipient whose time has come, one email with
//   every held notice that is still news.
// Each delivery is marked sent, skipped or failed (five attempts) in the
// transaction that sent it; a retry skips what was sent. Logs carry IDs.

import { type Database, sql, type Tx } from "@clubadmin/db";
import { DEFAULT_LOCALE, type Locale, localeOf } from "@clubadmin/i18n";
import {
  genericPush,
  message,
  openPushToken,
  renderNotice,
  unsubscribeToken,
  unsubscribeUrl,
} from "@clubadmin/server-kit/notifications";
import {
  effectiveSettings,
  isNotificationType,
  type NotificationCategory,
  notificationTypeInfo,
} from "@clubadmin/shared";
import type { Task } from "graphile-worker";

import type { MailHandlerOptions, MailMessage, MailProvider } from "../mail.ts";
import { nameFor, visibleName } from "../presenters/mail-names.ts";
import { movedEmails, type MovedOrigin } from "./handler.ts";
import { PUSH_BATCH, type PushMessage, type PushProvider } from "./push.ts";

const MAX_ATTEMPTS = 5;
const BATCH = 500;
const DIGEST_RECIPIENTS = 100;

export interface DeliveryDependencies {
  db: Database;
  mail: MailProvider | null;
  push: PushProvider | null;
  /** NOTIFICATION_TOKEN_KEY: unsubscribe links and sealed push tokens. */
  tokenKey: string | undefined;
  webUrl: string;
  mailOptions: Omit<MailHandlerOptions, "provider">;
  pushPerHour: number;
  now?: () => Date;
}

type DueRow = {
  id: string;
  status: "queued" | "held";
  attempts: number;
  notification_id: string;
  type: string;
  category: NotificationCategory;
  club_id: string | null;
  club_name: string | null;
  club_locale: string | null;
  subject_type: string;
  subject_id: string | null;
  about_person_ids: string[];
  params: Record<string, unknown>;
  read: boolean;
  recipient_person_id: string;
  account_id: string;
  email: string;
  locale: string | null;
  settings: unknown;
  token_sealed: string | null;
  device_disabled: boolean;
  dedupe_key: string;
};

const pickLocale = (...tags: (string | null | undefined)[]): Locale =>
  tags.map(localeOf).find((l): l is Locale => l !== null) ?? DEFAULT_LOCALE;

/** What it is about has started: a held notice is no longer worth sending. */
const started = (row: DueRow, now: Date) =>
  typeof row.params.startsAt === "string" && Date.parse(row.params.startsAt) <= now.getTime();

/** Due deliveries of a channel, oldest first, locked (the partial index `notification_deliveries_due_idx`). */
export const dueQuery = (
  channel: "email" | "push",
  digest: boolean,
  now: Date,
  extra = sql``,
) => sql`
    SELECT d.id, d.status, d.attempts, n.id AS notification_id, n.type, n.category, n.club_id,
      c.name AS club_name, c.default_locale AS club_locale, n.subject_type, n.subject_id,
      n.about_person_ids, n.params, n.read_at IS NOT NULL AS read, n.recipient_person_id,
      a.id AS account_id, a.email, a.locale, a.notification_settings AS settings,
      pd.token_sealed, pd.disabled_at IS NOT NULL AS device_disabled, n.dedupe_key
    FROM public.notification_deliveries d
    JOIN public.notifications n ON n.id = d.notification_id
    JOIN public.accounts a ON a.person_id = n.recipient_person_id
    LEFT JOIN public.clubs c ON c.id = n.club_id
    LEFT JOIN public.push_devices pd ON pd.id = d.push_device_id
    WHERE d.channel = ${channel} AND d.digest = ${digest} AND d.status IN ('queued', 'held')
      AND d.send_after <= ${now.toISOString()}::timestamptz ${extra}
    ORDER BY d.send_after, d.id
    LIMIT ${BATCH}
    FOR UPDATE OF d SKIP LOCKED`;

const due = (tx: Tx, channel: "email" | "push", digest: boolean, now: Date, extra = sql``) =>
  tx.execute<DueRow>(dueQuery(channel, digest, now, extra));

/** Pushes sent to these people in the hour before `at` (the per-person budget). */
export const pushBudgetQuery = (people: readonly string[], at: Date) => sql`
      SELECT n.recipient_person_id AS person_id, count(*)::int AS n
      FROM public.notification_deliveries d JOIN public.notifications n ON n.id = d.notification_id
      WHERE d.channel = 'push' AND d.status = 'sent'
        AND d.sent_at > ${new Date(at.getTime() - 3_600_000).toISOString()}::timestamptz
        AND n.recipient_person_id = ANY (${`{${people.join(",")}}`}::uuid[])
      GROUP BY n.recipient_person_id`;

/**
 * Recipients whose daily email is due. Starts from the due deliveries (a
 * materialised step on `notification_deliveries_due_idx`): few are due at a
 * time, so walking all recipients' notices would cost far more.
 */
export const digestRecipientsQuery = (at: Date) => sql`
      WITH due AS MATERIALIZED (
        SELECT d.notification_id FROM public.notification_deliveries d
        WHERE d.status = 'held' AND d.send_after <= ${at.toISOString()}::timestamptz
          AND d.channel = 'email' AND d.digest)
      SELECT DISTINCT n.recipient_person_id AS person_id
      FROM due JOIN public.notifications n ON n.id = due.notification_id
      LIMIT ${DIGEST_RECIPIENTS}`;

async function mark(
  tx: Tx,
  ids: readonly string[],
  status: "sent" | "skipped" | "failed",
  extra: { skipReason?: string; providerRef?: string | null; errorCode?: string } = {},
) {
  if (ids.length === 0) return;
  await tx.execute(sql`
    UPDATE public.notification_deliveries
    SET status = ${status}, skip_reason = ${extra.skipReason ?? null},
      provider_ref = coalesce(${extra.providerRef ?? null}, provider_ref),
      error_code = ${extra.errorCode ?? null},
      sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END
    WHERE id = ANY (${`{${ids.join(",")}}`}::uuid[])`);
}

/** A failed attempt: retried later with backoff, failed for good after five. */
async function retry(tx: Tx, row: DueRow, now: Date, code: string) {
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    await tx.execute(sql`
      UPDATE public.notification_deliveries SET status = 'failed', attempts = attempts + 1, error_code = ${code}
      WHERE id = ${row.id}`);
    return;
  }
  const backoff = 60_000 * 2 ** row.attempts;
  await tx.execute(sql`
    UPDATE public.notification_deliveries
    SET attempts = attempts + 1, error_code = ${code},
      send_after = ${new Date(now.getTime() + backoff).toISOString()}::timestamptz
    WHERE id = ${row.id}`);
}

export function deliverTask(deps: DeliveryDependencies): Task {
  const now = () => deps.now?.() ?? new Date();
  return async (_payload, helpers) => {
    const result = { push: 0, email: 0, digests: 0 };
    if (deps.push) result.push = await deliverPush(deps, now());
    if (deps.mail) {
      result.email = await deliverEmails(deps, now());
      result.digests = await deliverDigests(deps, now());
    }
    if (result.push + result.email + result.digests > 0) {
      helpers.logger.info("notifications delivered", result);
    }
  };
}

// --- Push ----------------------------------------------------------------------------

export async function deliverPush(deps: DeliveryDependencies, at: Date): Promise<number> {
  const provider = deps.push!;
  return deps.db.withSystem("notifications:deliver", {}, async (tx) => {
    const { rows } = await due(tx, "push", false, at);
    if (rows.length === 0) return 0;
    const people = [...new Set(rows.map((r) => r.recipient_person_id))];
    const { rows: recent } = await tx.execute<{ person_id: string; n: number }>(
      pushBudgetQuery(people, at),
    );
    const sentLastHour = new Map(recent.map((r) => [r.person_id, r.n]));
    const outgoing: { row: DueRow; message: PushMessage }[] = [];
    for (const row of rows) {
      if (!row.token_sealed || row.device_disabled || !deps.tokenKey) {
        await mark(tx, [row.id], "skipped", { skipReason: "no_device" });
      } else if (row.status === "held" && (row.read || started(row, at))) {
        await mark(tx, [row.id], "skipped", { skipReason: "quiet_obsolete" });
      } else if ((sentLastHour.get(row.recipient_person_id) ?? 0) >= deps.pushPerHour) {
        await mark(tx, [row.id], "skipped", { skipReason: "budget" });
      } else {
        sentLastHour.set(
          row.recipient_person_id,
          (sentLastHour.get(row.recipient_person_id) ?? 0) + 1,
        );
        const locale = pickLocale(row.locale, row.club_locale);
        const text = renderNotice(locale, {
          type: row.type,
          clubId: row.club_id,
          clubName: row.club_name,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          params: row.params,
        });
        const shown = effectiveSettings(row.settings).pushPreview
          ? { title: text.title, body: text.body }
          : genericPush(locale);
        outgoing.push({
          row,
          message: {
            to: openPushToken(deps.tokenKey, row.token_sealed),
            title: shown.title,
            body: shown.body,
            channelId: row.category,
            data: { notificationId: row.notification_id, link: text.link },
          },
        });
      }
    }
    for (let i = 0; i < outgoing.length; i += PUSH_BATCH) {
      const batch = outgoing.slice(i, i + PUSH_BATCH);
      let tickets;
      try {
        tickets = await provider.send(batch.map((b) => b.message));
      } catch {
        for (const b of batch) await retry(tx, b.row, at, "provider_unavailable");
        continue;
      }
      for (const [j, b] of batch.entries()) {
        const ticket = tickets[j];
        if (ticket?.status === "ok") {
          await mark(tx, [b.row.id], "sent", { providerRef: ticket.id });
        } else if (ticket?.code === "DeviceNotRegistered") {
          await mark(tx, [b.row.id], "skipped", {
            skipReason: "no_device",
            errorCode: ticket.code,
          });
          await disableDeviceOf(tx, b.row.id);
        } else {
          await retry(tx, b.row, at, ticket?.code ?? "PushError");
        }
      }
    }
    return outgoing.length;
  });
}

async function disableDeviceOf(tx: Tx, deliveryId: string) {
  await tx.execute(sql`
    UPDATE public.push_devices SET disabled_at = now()
    WHERE disabled_at IS NULL AND id = (
      SELECT push_device_id FROM public.notification_deliveries WHERE id = ${deliveryId})`);
}

/** `notifications:push_receipts`: reads Expo's receipts; DeviceNotRegistered disables the device. */
export function pushReceiptsTask(deps: DeliveryDependencies): Task {
  return async (_payload, helpers) => {
    if (!deps.push) return;
    const provider = deps.push;
    const at = deps.now?.() ?? new Date();
    const disabled = await deps.db.withSystem("notifications:push_receipts", {}, async (tx) => {
      const { rows } = await tx.execute<{ id: string; provider_ref: string }>(sql`
        SELECT id, provider_ref FROM public.notification_deliveries
        WHERE channel = 'push' AND status = 'sent' AND provider_ref IS NOT NULL
          AND sent_at < ${new Date(at.getTime() - 15 * 60_000).toISOString()}::timestamptz
          AND sent_at > ${new Date(at.getTime() - 24 * 3_600_000).toISOString()}::timestamptz
        ORDER BY sent_at LIMIT 1000`);
      if (rows.length === 0) return 0;
      const receipts = await provider.receipts(rows.map((r) => r.provider_ref));
      let n = 0;
      for (const r of rows) {
        const receipt = receipts.get(r.provider_ref);
        if (receipt?.status === "error" && receipt.code === "DeviceNotRegistered") {
          await disableDeviceOf(tx, r.id);
          n++;
        }
        // Checked: the reference is no longer needed.
        await tx.execute(sql`
          UPDATE public.notification_deliveries
          SET provider_ref = NULL, error_code = ${receipt?.status === "error" ? receipt.code : null}
          WHERE id = ${r.id}`);
      }
      return n;
    });
    if (disabled > 0) helpers.logger.info("push devices disabled", { disabled });
  };
}

// --- Email ---------------------------------------------------------------------------

/** "Gäller: Elsa Lindqvist" for the recipient: their wards by name, others only if not protected. */
async function aboutLine(tx: Tx, row: DueRow, locale: Locale): Promise<string> {
  if (row.about_person_ids.length === 0) return "";
  const names: string[] = [];
  for (const id of row.about_person_ids) {
    if (row.category === "leader" && row.club_id) {
      names.push(
        (await visibleName(tx, row.club_id, id)) ?? message(locale, "notify.protectedMember", {}),
      );
    } else {
      names.push(await nameFor(tx, id));
    }
  }
  return message(locale, "notify.about", { names: names.filter(Boolean).join(", ") });
}

function footer(deps: DeliveryDependencies, row: DueRow, locale: Locale): string {
  const club = row.club_name
    ? message(locale, "email.footer", { club: row.club_name })
    : message(locale, "email.footerPlain", {});
  const info = isNotificationType(row.type) ? notificationTypeInfo(row.type) : null;
  if (info?.mandatoryEmail || !deps.tokenKey) {
    return `${club}\n${message(locale, "notify.mandatory", {})}`;
  }
  const url = unsubscribeUrl(
    deps.webUrl,
    unsubscribeToken(deps.tokenKey, row.account_id, row.category),
  );
  return `${club}\n${message(locale, "notify.unsubscribe", { url, settings: new URL("/me/notifications/settings", deps.webUrl).toString() })}`;
}

function listHeaders(deps: DeliveryDependencies, row: DueRow): Record<string, string> {
  const info = isNotificationType(row.type) ? notificationTypeInfo(row.type) : null;
  if (info?.mandatoryEmail || !deps.tokenKey) return {};
  const token = unsubscribeToken(deps.tokenKey, row.account_id, row.category);
  return {
    "List-Unsubscribe": `<${new URL(`/api/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`, deps.webUrl).toString()}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** One notice as an email (null: nothing to send any more). */
async function noticeEmail(
  deps: DeliveryDependencies,
  tx: Tx,
  row: DueRow,
): Promise<MailMessage | null> {
  const locale = pickLocale(row.locale, row.club_locale);
  const origin = row.params.origin as MovedOrigin | undefined;
  if (origin) {
    const emails = await movedEmails(tx, deps.mailOptions, origin);
    const m = emails.get(row.recipient_person_id);
    if (!m) return null;
    // The original text, with the notice's footer (unsubscribe where allowed).
    const body = m.text.slice(0, m.text.lastIndexOf("\n\n-- \n"));
    return {
      to: m.to,
      subject: m.subject,
      text: `${body}\n\n-- \n${footer(deps, row, locale)}\n`,
      messageId: `${row.dedupe_key}.${row.recipient_person_id}`,
      headers: listHeaders(deps, row),
    };
  }
  let to = row.email;
  if (row.type === "account.email.changed") {
    // The previous address, from the account's history (no payload carries an address).
    const { rows } = await tx.execute<{ email: string | null }>(sql`
      SELECT app.previous_account_email(${row.account_id}) AS email`);
    if (!rows[0]?.email) return null;
    to = rows[0].email;
  }
  const text = renderNotice(locale, {
    type: row.type,
    clubId: row.club_id,
    clubName: row.club_name,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    params: row.params,
  });
  const about = await aboutLine(tx, row, locale);
  const lines = [text.title, text.body, about, new URL(text.link, deps.webUrl).toString()].filter(
    Boolean,
  );
  return {
    to,
    subject: text.title,
    text: `${lines.join("\n\n")}\n\n-- \n${footer(deps, row, locale)}\n`,
    messageId: `${row.dedupe_key}.${row.recipient_person_id}`,
    headers: listHeaders(deps, row),
  };
}

export async function deliverEmails(deps: DeliveryDependencies, at: Date): Promise<number> {
  const mail = deps.mail!;
  return deps.db.withSystem("notifications:deliver", {}, async (tx) => {
    const { rows } = await due(tx, "email", false, at);
    let sent = 0;
    for (const row of rows) {
      const message = await noticeEmail(deps, tx, row);
      if (!message) {
        await mark(tx, [row.id], "skipped", { skipReason: "obsolete" });
        continue;
      }
      try {
        await mail.send(message);
        await mark(tx, [row.id], "sent", { providerRef: message.messageId });
        sent++;
      } catch {
        await retry(tx, row, at, "smtp_error");
      }
    }
    return sent;
  });
}

/** The daily email: per recipient due, every held notice that is still news, in one email. */
export async function deliverDigests(deps: DeliveryDependencies, at: Date): Promise<number> {
  const mail = deps.mail!;
  const { rows: people } = await deps.db.withSystem("notifications:digest", {}, (tx) =>
    tx.execute<{ person_id: string }>(digestRecipientsQuery(at)),
  );
  let sent = 0;
  for (const { person_id } of people) {
    sent += await deps.db.withSystem("notifications:digest", {}, async (tx) => {
      const { rows } = await due(
        tx,
        "email",
        true,
        at,
        sql`AND n.recipient_person_id = ${person_id}`,
      );
      const stale = rows.filter((r) => r.read || started(r, at));
      await mark(
        tx,
        stale.map((r) => r.id),
        "skipped",
        { skipReason: "digest_obsolete" },
      );
      const news = rows.filter((r) => !stale.includes(r));
      if (news.length === 0) return 0;
      const first = news[0]!;
      const locale = pickLocale(first.locale, first.club_locale);
      const sections = new Map<string, string[]>();
      for (const row of news) {
        const text = renderNotice(locale, {
          type: row.type,
          clubId: row.club_id,
          clubName: row.club_name,
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          params: row.params,
        });
        const about = await aboutLine(tx, row, locale);
        const heading = row.club_name ?? message(locale, "notify.digest.noClub", {});
        const line = [
          `- ${text.title}`,
          text.body ? `  ${text.body}` : "",
          about ? `  ${about}` : "",
          `  ${new URL(text.link, deps.webUrl).toString()}`,
        ]
          .filter(Boolean)
          .join("\n");
        sections.set(heading, [...(sections.get(heading) ?? []), line]);
      }
      const categories = [...new Set(news.map((r) => r.category))];
      const unsubscribe = deps.tokenKey
        ? categories
            .filter(
              (c) =>
                !news.every(
                  (r) =>
                    r.category === c &&
                    isNotificationType(r.type) &&
                    notificationTypeInfo(r.type).mandatoryEmail,
                ),
            )
            .map((c) =>
              message(locale, "notify.digest.unsubscribeCategory", {
                category: message(locale, `notifyCategories.${c}`, {}),
                url: unsubscribeUrl(
                  deps.webUrl,
                  unsubscribeToken(deps.tokenKey!, first.account_id, c),
                ),
              }),
            )
        : [];
      const body = [
        message(locale, "notify.digest.intro", { count: String(news.length) }),
        ...[...sections].map(([heading, lines]) => `${heading}\n${lines.join("\n")}`),
      ].join("\n\n");
      const date = at.toISOString().slice(0, 10);
      const messageId = `digest-${date}.${person_id}`;
      try {
        await mail.send({
          to: first.email,
          subject: message(locale, "notify.digest.subject", { count: String(news.length) }),
          text: `${body}\n\n-- \n${message(locale, "email.footerPlain", {})}\n${[...unsubscribe, message(locale, "notify.digest.settings", { url: new URL("/me/notifications/settings", deps.webUrl).toString() })].join("\n")}\n`,
          messageId,
        });
      } catch {
        // Stays held; the next run tries again.
        return 0;
      }
      await mark(
        tx,
        news.map((r) => r.id),
        "sent",
        { providerRef: messageId },
      );
      return 1;
    });
  }
  return sent;
}
