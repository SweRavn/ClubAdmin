// SPDX-License-Identifier: AGPL-3.0-only
// My family (P1.3), read-only in the app: the people I am linked to and,
// for each, their guardians, relatives and contact persons with their
// rights. Adding, inviting and changing happen on the web.

import { enumKey } from "@clubadmin/i18n";
import { personLabel } from "@clubadmin/shared";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { type MyWards, useMyWards, useWardGuardians } from "../../../api/queries.ts";
import { ErrorView } from "../../../components/error-view.tsx";
import { PersonName } from "../../../components/person-name.tsx";
import { RoleBadge } from "../../../components/role-badge.tsx";
import { EmptyState, Loading, Muted, Row, Screen, Section } from "../../../components/ui.tsx";

function WardSection({ ward }: { ward: MyWards["wards"][number] }) {
  const t = useTranslations();
  const guardians = useWardGuardians(ward.person.id);
  const list = guardians.data?.guardians ?? [];
  return (
    <Section title={t("family.guardiansOf", { name: personLabel(ward.person) })}>
      <Row testID={`family-ward-${ward.person.id}`}>
        <PersonName person={ward.person} />
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <RoleBadge label={t(enumKey("guardianKinds", ward.kind))} tone="accent" />
        </View>
        <Muted>
          {ward.rights.length
            ? ward.rights.map((r) => t(enumKey("guardianRights", r))).join(", ")
            : t("family.noRights")}
        </Muted>
      </Row>
      {guardians.isError ? (
        <ErrorView error={guardians.error} onRetry={() => void guardians.refetch()} />
      ) : null}
      {list.map((g, index) => (
        <Row
          key={g.guardianshipId}
          last={index === list.length - 1}
          testID={`family-guardian-${g.person.id}`}
        >
          <PersonName person={g.person} />
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
            <RoleBadge label={t(enumKey("guardianKinds", g.kind))} />
            {g.isYou ? <RoleBadge label={t("family.you")} /> : null}
          </View>
          {g.kind === "relative" || g.kind === "contact_person" ? (
            <Muted>
              {g.rights.length
                ? g.rights.map((r) => t(enumKey("guardianRights", r))).join(", ")
                : t("family.noRights")}
            </Muted>
          ) : null}
          {g.phone ? <Muted>{g.phone}</Muted> : null}
        </Row>
      ))}
    </Section>
  );
}

export default function Family() {
  const t = useTranslations();
  const wards = useMyWards();
  if (!wards.data) {
    if (wards.isError)
      return (
        <Screen>
          <ErrorView error={wards.error} onRetry={() => void wards.refetch()} />
        </Screen>
      );
    return <Loading label={t("common.loading")} />;
  }
  return (
    <Screen
      refreshing={wards.isRefetching}
      onRefresh={() => void wards.refetch()}
      testID="family-screen"
    >
      {wards.data.wards.length === 0 ? (
        <EmptyState title={t("family.noChildren")} />
      ) : (
        wards.data.wards.map((ward) => <WardSection key={ward.person.id} ward={ward} />)
      )}
    </Screen>
  );
}
