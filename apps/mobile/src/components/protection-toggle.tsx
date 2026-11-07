// SPDX-License-Identifier: AGPL-3.0-only
// Protected identity of the caller or a ward (P1.12, ADR 0022): the state,
// what it means, and on/off behind a confirmation. Turning it off needs a
// recent login: the server's step-up answer is shown. Writes need a
// connection (no outbox for these).

import { Alert, View } from "react-native";
import { useTranslations } from "use-intl";

import { usePerson, useSetProtection } from "../api/queries.ts";
import { ErrorView } from "./error-view.tsx";
import { Body, Button, Muted } from "./ui.tsx";

export function ProtectionToggle({ personId, testID }: { personId: string; testID: string }) {
  const t = useTranslations();
  const person = usePerson(personId, null);
  const set = useSetProtection();
  const protection = person.data?.protection;
  if (!protection) {
    return person.isError ? <ErrorView error={person.error} /> : null;
  }
  const confirm = (on: boolean) =>
    Alert.alert(
      on ? t("protection.turnOn") : t("protection.turnOff"),
      on
        ? [
            t("protection.othersDont"),
            t("protection.whoSees"),
            t("protection.addressDeleted"),
          ].join("\n\n")
        : t("protection.turnOffConsequences"),
      [
        { text: t("protection.cancel"), style: "cancel" },
        {
          text: on ? t("protection.turnOnConfirm") : t("protection.turnOffConfirm"),
          style: on ? "default" : "destructive",
          onPress: () => set.mutate({ personId, protected: on }),
        },
      ],
    );
  return (
    <View style={{ gap: 8 }} testID={testID}>
      <Body>{protection.global ? t("protection.stateOn") : t("protection.stateOff")}</Body>
      {!protection.global ? <Muted>{t("protection.explain")}</Muted> : null}
      {!protection.canChangeGlobal ? null : !protection.global ? (
        <Button
          label={t("protection.turnOn")}
          busy={set.isPending}
          onPress={() => confirm(true)}
          testID={`${testID}-on`}
        />
      ) : protection.canRemoveGlobal ? (
        <Button
          label={t("protection.turnOff")}
          kind="secondary"
          busy={set.isPending}
          onPress={() => confirm(false)}
          testID={`${testID}-off`}
        />
      ) : (
        <Muted>{t("protection.removalRefused")}</Muted>
      )}
      {set.isError ? <ErrorView error={set.error} /> : null}
    </View>
  );
}
