// SPDX-License-Identifier: AGPL-3.0-only
// Edit an event (P1.6): the organisers' form. "Add a question" saves and
// returns with one more empty question row.
import { forbidden } from "next/navigation";
import { getTranslations } from "next-intl/server";

import {
  ActionForm,
  buttonClass,
  secondaryButtonClass,
} from "../../../../../components/action-form.tsx";
import { EventFields } from "../../../../../components/event-fields.tsx";
import { FormError } from "../../../../../components/form-error.tsx";
import { getEvent, getLocations } from "../../../../../server/data.ts";

type Props = {
  params: Promise<{ eventId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata() {
  return { title: (await getTranslations())("events.editTitle") };
}

export default async function EditEventPage({ params, searchParams }: Props) {
  const [{ eventId }, query] = await Promise.all([params, searchParams]);
  const [t, event] = await Promise.all([getTranslations(), getEvent(eventId)]);
  if (!event.canManage) forbidden();
  const locations = await getLocations(event.clubId);
  const rows = Math.min(Math.max(Number(query.rows) || 1, 1), 5);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted">
        <a href={`/events/${event.id}`} className="underline">
          {event.title}
        </a>
      </p>
      <h1 className="text-2xl font-semibold">{t("events.editTitle")}</h1>
      <FormError code={query.error} />
      <ActionForm action="update-event" className="space-y-6" testId="edit-event-form">
        <input type="hidden" name="eventId" value={event.id} />
        <input type="hidden" name="rows" value={rows} />
        <EventFields
          timeZone={event.timeZone}
          locations={locations}
          values={{ ...event, locationId: event.location?.id ?? null }}
          emptyRows={rows}
        />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass} data-testid="event-save">
            {t("events.save")}
          </button>
          <button
            type="submit"
            name="more"
            value="1"
            className={secondaryButtonClass}
            data-testid="event-add-question"
          >
            {t("events.addQuestion")}
          </button>
        </div>
      </ActionForm>
    </div>
  );
}
