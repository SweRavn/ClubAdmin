// SPDX-License-Identifier: AGPL-3.0-only
// Changing an activity (P2.7g): the same fields as a new one, for those who
// manage it. A series' session changes only itself (series stay on the
// web). Needs a connection; back to the activity when saved.

import { router, Stack } from "expo-router";
import { useTranslations } from "use-intl";

import { useActivity, useLocations, useUpdateActivity } from "../../../../api/queries.ts";
import { ActivityForm } from "../../../../components/activity-form.tsx";
import { activityValuesOf } from "../../../../components/activity-logic.ts";
import { ErrorView } from "../../../../components/error-view.tsx";
import { useIdParam } from "../../../../components/route-id.ts";
import { EmptyState, Loading, Muted, Screen } from "../../../../components/ui.tsx";
import NotFound from "../../../+not-found.tsx";

export default function EditActivityScreen() {
  const activityId = useIdParam("activityId");
  if (!activityId) return <NotFound />;
  return <EditActivity activityId={activityId} />;
}

function EditActivity({ activityId }: { activityId: string }) {
  const t = useTranslations();
  const activity = useActivity(activityId);
  const locations = useLocations(activity.data?.clubId);
  const update = useUpdateActivity(activityId);
  const a = activity.data;
  // The form keeps its first values: a refresh does not undo typing.
  const initial = a ? activityValuesOf(a, a.timeZone) : null;

  if (activity.isError) {
    return (
      <Screen>
        <ErrorView error={activity.error} onRetry={() => void activity.refetch()} />
      </Screen>
    );
  }
  if (!a || !initial) return <Loading label={t("common.loading")} />;
  if (!a.canManage) {
    return (
      <Screen>
        <EmptyState title={t("errors.forbidden.title")} body={t("errors.forbidden.text")} />
      </Screen>
    );
  }
  return (
    <Screen testID="edit-activity-screen">
      <Stack.Screen options={{ title: t("activities.edit") }} />
      {a.seriesId ? <Muted>{t("mobile.seriesSessionOnly")}</Muted> : null}
      <ActivityForm
        edit
        initial={initial}
        timeZone={a.timeZone}
        locations={locations.data ?? []}
        submitLabel={t("activities.save")}
        busy={update.isPending}
        error={update.error}
        onSubmit={(body) =>
          update.mutate(body, {
            onSuccess: () => router.back(),
          })
        }
      />
    </Screen>
  );
}
