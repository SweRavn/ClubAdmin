// SPDX-License-Identifier: AGPL-3.0-only
// The entries of a history panel or the club-wide changes (P1.9, ADR 0042):
// newest first, one action's rows together (same transaction), who and when,
// what kind of record and whom it is about, and the column changes with old
// and new values. Values come formatted by the API (enum keys, ISO dates,
// resolved references); people only as the API presented them. "Show
// older" is a plain link with the cursor (works without JavaScript).

import type {
  ActorReference,
  HistoryChange,
  HistoryItem,
  HistoryPage,
  HistoryRef,
  HistoryValue,
} from "@clubadmin/shared";
import { EmptyState, PersonName } from "@clubadmin/ui";
import { getLocale, getTranslations } from "next-intl/server";

/**
 * The translator with keys built at run time (resources, enum values, verbs
 * from the API): checked with has() and a fallback rather than at compile time.
 */
export interface Tr {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
  raw(key: string): unknown;
}
type T = Tr;

export async function translator(): Promise<Tr> {
  return (await getTranslations()) as unknown as Tr;
}

export interface HistoryFormat {
  t: T;
  locale: string;
  timeZone: string;
  /** The club, for links to people (their profile in the club). */
  clubId: string;
}

const HREF: Record<string, (id: string, clubId: string) => string> = {
  person: (id, clubId) => `/people/${id}?clubId=${clubId}`,
  group: (id) => `/groups/${id}`,
  activity: (id) => `/activities/${id}`,
  series: (id) => `/activity-series/${id}`,
  event: (id) => `/events/${id}`,
  club: (id) => `/clubs/${id}`,
};

export function recordHref(
  link: { kind: string; id: string } | null,
  clubId: string,
): string | null {
  const href = link ? HREF[link.kind] : undefined;
  return link && href ? href(link.id, clubId) : null;
}

/** A message that may not exist (an enum value added later): the raw value instead. */
function label(t: T, key: string, fallback: string): string {
  return t.has(key) ? t(key) : fallback;
}

export function formatDateTime(f: HistoryFormat, value: string): string {
  return new Intl.DateTimeFormat(f.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: f.timeZone,
  }).format(new Date(value));
}

export function RefText({ value, f }: { value: HistoryRef; f: HistoryFormat }) {
  const protectedLabel = f.t("protected.tooltip");
  switch (value.kind) {
    case "person":
      return (
        <PersonName
          person={value.person}
          href={HREF.person!(value.person.id, f.clubId)}
          protectedLabel={protectedLabel}
        />
      );
    case "hidden_person":
      return <span className="text-muted">{f.t("history.hiddenPerson")}</span>;
    case "erased_person":
      return <span className="text-muted">{f.t("history.actorErased")}</span>;
    case "record": {
      const name =
        value.name ??
        (value.startsAt ? formatDateTime(f, value.startsAt) : null) ??
        f.t("history.none");
      const href = HREF[value.type]?.(value.id, f.clubId);
      return href ? (
        <a href={href} className="text-accent underline-offset-2 hover:underline">
          {name}
        </a>
      ) : (
        <span>{name}</span>
      );
    }
  }
}

function ValueText({ value, f }: { value: HistoryValue | null; f: HistoryFormat }) {
  if (value === null) return <span className="text-muted">{f.t("history.none")}</span>;
  switch (value.type) {
    case "text":
      return <span>{value.value}</span>;
    case "number":
      return <span>{new Intl.NumberFormat(f.locale).format(value.value)}</span>;
    case "boolean":
      return <span>{f.t(value.value ? "history.yes" : "history.no")}</span>;
    case "date":
      return (
        <span>
          {new Intl.DateTimeFormat(f.locale, { dateStyle: "medium", timeZone: "UTC" }).format(
            new Date(`${value.value}T00:00:00Z`),
          )}
        </span>
      );
    case "datetime":
      return <span>{formatDateTime(f, value.value)}</span>;
    case "enum":
      return <span>{label(f.t, `${value.enumKey}.${value.value}`, value.value)}</span>;
    case "ref":
      return <RefText value={value.ref} f={f} />;
    case "list":
      return value.items.length === 0 ? (
        <span className="text-muted">{f.t("history.none")}</span>
      ) : (
        <span>
          {value.items.map((item, i) => (
            <span key={i}>
              {i > 0 ? ", " : null}
              <ValueText value={item} f={f} />
            </span>
          ))}
        </span>
      );
  }
}

export function ActorText({
  actor,
  onBehalfOf,
  f,
}: {
  actor: ActorReference;
  onBehalfOf: ActorReference | null;
  f: HistoryFormat;
}) {
  const one = (a: ActorReference) => {
    switch (a.kind) {
      case "person":
        return <RefText value={a} f={f} />;
      case "protected":
        return <span>{f.t("history.actorProtected")}</span>;
      case "erased":
        return <span>{f.t("history.actorErased")}</span>;
      case "operator":
        return <span>{f.t("history.actorOperator")}</span>;
      default:
        // "system", and kinds a newer API adds (ADR 0029).
        return (
          <span>
            {"job" in a && a.job
              ? f.t("history.actorJob", { job: a.job })
              : f.t("history.actorSystem")}
          </span>
        );
    }
  };
  if (!onBehalfOf) return one(actor);
  return (
    <span>
      {one(actor)} → {one(onBehalfOf)}
    </span>
  );
}

function ChangeRow({ change, f }: { change: HistoryChange; f: HistoryFormat }) {
  const name = label(f.t, change.labelKey, change.column);
  return (
    <li data-column={change.column}>
      <span className="text-muted">{name}:</span>{" "}
      {change.kind === "erased" ? (
        <span>{f.t("history.erased")}</span>
      ) : change.kind === "redacted" ? (
        <span>{f.t("history.redacted")}</span>
      ) : (
        <>
          <ValueText value={change.old} f={f} /> → <ValueText value={change.new} f={f} />
        </>
      )}
    </li>
  );
}

function Entry({ item, f, links }: { item: HistoryItem; f: HistoryFormat; links: boolean }) {
  const href = links ? recordHref(item.link, f.clubId) : null;
  const resource = label(f.t, `history.resources.${item.resource}`, item.resource);
  return (
    <li className="space-y-1" data-testid="history-entry" data-resource={item.resource}>
      <div>
        <span className="font-medium">{resource}</span>{" "}
        <span className="text-muted">{f.t(`history.${item.operation}`)}</span>
        {item.about.length > 0 ? (
          <>
            {" · "}
            {item.about.map((a, i) => (
              <span key={i}>
                {i > 0 ? ", " : null}
                <RefText value={a} f={f} />
              </span>
            ))}
          </>
        ) : null}
        {href ? (
          <>
            {" · "}
            <a href={href} className="text-sm text-accent underline">
              {f.t("history.open")}
            </a>
          </>
        ) : null}
      </div>
      {item.changes.length > 0 || item.otherFieldsChanged ? (
        <ul className="ml-4 list-disc text-sm">
          {item.changes.map((c) => (
            <ChangeRow key={c.column} change={c} f={f} />
          ))}
          {item.otherFieldsChanged ? (
            <li className="text-muted">{f.t("history.otherFields")}</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** Consecutive rows of one transaction: one action. */
function groups(items: readonly HistoryItem[]): HistoryItem[][] {
  const out: HistoryItem[][] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last[0]!.transactionId === item.transactionId) last.push(item);
    else out.push([item]);
  }
  return out;
}

export async function HistoryList({
  page,
  timeZone,
  clubId,
  olderHref,
  links = false,
}: {
  page: HistoryPage;
  timeZone: string;
  clubId: string;
  /** The URL of the next page (the caller adds the cursor to its own query). */
  olderHref: (cursor: string) => string;
  /** Link each entry to its record's page (the club-wide view). */
  links?: boolean;
}) {
  const [t, locale] = await Promise.all([translator(), getLocale()]);
  const f: HistoryFormat = { t, locale, timeZone, clubId };
  return (
    <div className="space-y-4" data-testid="history-list">
      {page.items.length === 0 ? (
        <EmptyState title={t("history.empty")} />
      ) : (
        <ol className="space-y-4">
          {groups(page.items).map((group) => {
            const first = group[0]!;
            return (
              <li
                key={first.id}
                className="rounded-lg border border-border bg-raised p-3"
                data-testid="history-action"
              >
                <div className="mb-2 text-sm">
                  <ActorText actor={first.actor} onBehalfOf={first.onBehalfOf} f={f} />
                  <span className="text-muted"> · {formatDateTime(f, first.changedAt)}</span>
                </div>
                <ul className="space-y-2">
                  {group.map((item) => (
                    <Entry key={item.id} item={item} f={f} links={links} />
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      {page.nextCursor ? (
        <a
          href={olderHref(page.nextCursor)}
          className="inline-block text-sm text-accent underline"
          data-testid="history-older"
        >
          {t("history.showOlder")}
        </a>
      ) : null}
      <p className="text-sm text-muted">
        {t("history.retention", { months: page.retentionMonths })}
      </p>
    </div>
  );
}

/** The problem codes a history read can answer with, as the page explains them. */
export async function HistoryError({ code }: { code: string }) {
  const t = await translator();
  const key =
    code === "mfa_required"
      ? "problem.mfa-required"
      : ["history_scope_too_large", "range_too_large", "history_timeout"].includes(code)
        ? `joinErrors.${code}`
        : "history.error";
  return (
    <p className="rounded-md border border-border bg-raised p-3 text-sm" role="alert">
      {t(key)}
    </p>
  );
}
