// SPDX-License-Identifier: AGPL-3.0-only
// Settings → "Samåkning" (P2.7f in the app, P2.7g): my defaults as a driver
// (seats, departure place, a note for the passengers, the way home's minutes
// after the end). With them, "Skapa samåkning" offers my car in one tap.
// Adults only (`canSet`); saving needs a connection.

import { Stack } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import {
  type PersonalCarpoolSettings,
  useMyCarpoolSettings,
  useSaveMyCarpoolSettings,
} from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { FormError, formErrorsOf, TextField, useOnline } from "../../../components/form.tsx";
import { Button, EmptyState, Loading, Muted, Screen } from "../../../components/ui.tsx";
import { useTheme } from "../../../theme.ts";

export default function CarpoolSettingsScreen() {
  const t = useTranslations();
  const settings = useMyCarpoolSettings();
  if (!settings.data) {
    if (settings.isError)
      return (
        <Screen>
          <ErrorView error={settings.error} onRetry={() => void settings.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  return (
    <Screen testID="carpool-settings-screen">
      <Stack.Screen options={{ title: t("carpool.defaults.title") }} />
      {settings.data.canSet ? (
        <Defaults settings={settings.data.settings} />
      ) : (
        <EmptyState title={t("mobile.carpoolAdultsOnly")} />
      )}
    </Screen>
  );
}

function Defaults({ settings }: { settings: PersonalCarpoolSettings | null }) {
  const t = useTranslations();
  const theme = useTheme();
  const online = useOnline();
  const save = useSaveMyCarpoolSettings();
  const [seats, setSeats] = useState(String(settings?.seats ?? 3));
  const [place, setPlace] = useState(settings?.departurePlace ?? "");
  const [note, setNote] = useState(settings?.note ?? "");
  const [minutes, setMinutes] = useState(
    settings?.returnMinutes === null || settings?.returnMinutes === undefined
      ? ""
      : String(settings.returnMinutes),
  );
  const [local, setLocal] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const remote = formErrorsOf(save.error);
  const errors = { form: remote.form, fields: { ...remote.fields, ...local } };
  const submit = () => {
    const n = Number(seats);
    const m = minutes === "" ? null : Number(minutes);
    const wrong: Record<string, string> = {};
    if (!(Number.isInteger(n) && n >= 1 && n <= 8)) wrong.seats = "invalid_number";
    if (m !== null && !(Number.isInteger(m) && m >= 0 && m <= 240)) {
      wrong.returnMinutes = "invalid_number";
    }
    setLocal(wrong);
    setSaved(false);
    if (Object.keys(wrong).length > 0) return;
    save.mutate(
      {
        seats: n,
        departurePlace: place.trim() || null,
        note: note.trim() || null,
        returnMinutes: m,
      },
      { onSuccess: () => setSaved(true) },
    );
  };
  return (
    <View style={{ gap: theme.space(3) }}>
      <Muted>{t("carpool.defaults.intro")}</Muted>
      <TextField
        label={t("carpool.defaults.seats")}
        name="defaults-seats"
        keyboardType="number-pad"
        value={seats}
        onChange={(v) => setSeats(v.replace(/[^0-9]/g, ""))}
        maxLength={1}
        error={errors.fields.seats}
      />
      <TextField
        label={t("carpool.defaults.departurePlace")}
        name="defaults-departurePlace"
        value={place}
        onChange={setPlace}
        maxLength={200}
        error={errors.fields.departurePlace}
      />
      <TextField
        label={t("carpool.defaults.note")}
        name="defaults-note"
        value={note}
        onChange={setNote}
        maxLength={300}
        error={errors.fields.note}
      />
      <TextField
        label={t("carpool.defaults.returnMinutes")}
        name="defaults-returnMinutes"
        keyboardType="number-pad"
        value={minutes}
        onChange={(v) => setMinutes(v.replace(/[^0-9]/g, ""))}
        maxLength={3}
        hint={t("carpool.defaults.returnHint")}
        error={errors.fields.returnMinutes}
      />
      <FormError errors={errors} />
      {saved ? <Muted testID="defaults-saved">{t("carpool.defaults.saved")}</Muted> : null}
      {online ? null : <Muted>{t("mobile.needsConnection")}</Muted>}
      <Button
        label={t("carpool.defaults.save")}
        disabled={!online}
        busy={save.isPending && save.variables !== null}
        onPress={submit}
        testID="defaults-save"
      />
      {settings ? (
        <Button
          kind="secondary"
          label={t("carpool.defaults.clear")}
          disabled={!online}
          busy={save.isPending && save.variables === null}
          onPress={() => save.mutate(null, { onSuccess: () => setSaved(true) })}
          testID="defaults-clear"
        />
      ) : null}
    </View>
  );
}
