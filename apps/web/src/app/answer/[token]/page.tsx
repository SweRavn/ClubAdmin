// SPDX-License-Identifier: AGPL-3.0-only
// An answer link of a calendar subscription (P1.11, ADR 0044): "Elsa is
// coming / not coming" from an event's description in a calendar app. No
// login and no app shell; the link only shows what it would answer, and
// "Confirm" answers (a calendar app or link preview opening the link changes
// nothing). The token is in the path, redacted from logs and traces; the
// page sends no referrer.
import { CalendarAnswerSchema, z } from "@clubadmin/shared";
import { formatDateTime } from "@clubadmin/ui";
import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";

import { buttonClass } from "../../../components/action-form.tsx";
import { apiFetch } from "../../../server/api.ts";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const TOKEN = /^[A-Za-z0-9_-]{87}$/;
const DONE = z.enum(["attending", "not_attending"]);

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: (await getTranslations())("calendar.answer.title"),
    robots: { index: false },
    referrer: "no-referrer",
  };
}

type Loaded =
  | { kind: "ok"; answer: z.infer<typeof CalendarAnswerSchema> }
  | { kind: "invalid" | "expired" | "failed" };

async function load(token: string): Promise<Loaded> {
  if (!TOKEN.test(token)) return { kind: "invalid" };
  const res = await apiFetch(`/api/v1/calendar-answers/${token}`, null, {});
  if (res.status === 404) return { kind: "invalid" };
  if (res.status === 410) return { kind: "expired" };
  if (!res.ok) return { kind: "failed" };
  const parsed = CalendarAnswerSchema.safeParse(await res.json().catch(() => null));
  return parsed.success ? { kind: "ok", answer: parsed.data } : { kind: "failed" };
}

export default async function CalendarAnswerPage({ params, searchParams }: Props) {
  const [{ token }, query, t, locale] = await Promise.all([
    params,
    searchParams,
    getTranslations(),
    getLocale(),
  ]);
  const loaded = await load(token);
  const done = DONE.safeParse(query.done);
  const error = typeof query.error === "string" ? query.error : null;
  const answerText = (s: "attending" | "not_attending") => t(`calendar.answer.answers.${s}`);

  let content;
  if (loaded.kind !== "ok") {
    content = (
      <p role="alert" data-testid="answer-invalid">
        {loaded.kind === "expired"
          ? t("calendar.answer.expired")
          : loaded.kind === "invalid"
            ? t("calendar.answer.invalid")
            : t("joinErrors.failed")}
      </p>
    );
  } else {
    const { answer } = loaded;
    const a = answer.activity;
    const when = formatDateTime(a.startsAt, {
      locale,
      timeZone: a.timeZone,
      dateStyle: "full",
      timeStyle: "short",
    });
    const sentence = t(
      answer.status === "attending" ? "calendar.answer.coming" : "calendar.answer.notComing",
      { name: answer.personName, title: a.title },
    );
    const canConfirm =
      !a.cancelled &&
      answer.open &&
      !(answer.deadlinePassed && answer.status === "attending") &&
      !done.success;
    content = (
      <div className="space-y-4">
        <p className="text-lg font-semibold" data-testid="answer-sentence">
          {sentence}
        </p>
        <p className="text-muted">
          {a.place ? t("calendar.answer.when", { when, place: a.place }) : when} · {a.clubName}
        </p>
        {done.success ? (
          <p
            role="status"
            className="rounded-md bg-accent-soft px-3 py-2"
            data-testid="answer-saved"
          >
            {t("calendar.answer.saved", { answer: answerText(done.data) })}
          </p>
        ) : answer.currentAnswer ? (
          <p>{t("calendar.answer.current", { answer: answerText(answer.currentAnswer) })}</p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md bg-protected-soft px-3 py-2">
            {error === "answer_link_expired"
              ? t("calendar.answer.expired")
              : t("joinErrors.failed")}
          </p>
        ) : null}
        {a.cancelled ? (
          <p role="alert">{t("calendar.answer.cancelled")}</p>
        ) : !answer.open ? (
          <p role="alert">{t("calendar.answer.closed")}</p>
        ) : answer.deadlinePassed && answer.status === "attending" ? (
          <p role="alert">{t("calendar.answer.deadlinePassed")}</p>
        ) : null}
        {canConfirm ? (
          <form method="post" action={`/answer/${token}/confirm`}>
            <button type="submit" className={buttonClass} data-testid="answer-confirm">
              {t("calendar.answer.confirm")}
            </button>
          </form>
        ) : null}
      </div>
    );
  }

  return (
    <main id="main" className="mx-auto w-full max-w-lg flex-1 space-y-4 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t("calendar.answer.title")}</h1>
      {content}
      <p>
        <a href="/schedule" className="underline">
          {t("calendar.answer.toSchedule")}
        </a>
      </p>
    </main>
  );
}
