// SPDX-License-Identifier: AGPL-3.0-only
// DEV_AUTH persona picker for development builds (docs/seed-data.md): log
// in as any demo person, grouped by club, with the persona descriptions and
// an MFA toggle, as on the web. Only loaded when DEV_AUTH_BUILD is true;
// preview and production bundles do not contain it (CI checks).

import { enumKey } from "@clubadmin/i18n";
import { type PersonaList, personLabel } from "@clubadmin/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Switch, View } from "react-native";
import { useTranslations } from "use-intl";

import { fetchPersonas } from "../auth/dev-login.ts";
import { useTheme } from "../theme.ts";
import { Body, Muted, Row, Section } from "./ui.tsx";

type Persona = PersonaList["personas"][number];

interface ClubGroup {
  key: string;
  name: string;
  entries: { persona: Persona; roles: string[] }[];
}

export function groupByClub(personas: Persona[], noClub: string): ClubGroup[] {
  const groups = new Map<string, ClubGroup>();
  for (const persona of personas) {
    const clubs = persona.clubs.length > 0 ? persona.clubs : [null];
    for (const club of clubs) {
      const key = club?.clubId ?? "none";
      const group = groups.get(key) ?? { key, name: club?.clubName ?? noClub, entries: [] };
      group.entries.push({ persona, roles: club?.roles ?? [] });
      groups.set(key, group);
    }
  }
  return [...groups.values()];
}

export function PersonaPicker({ onPick }: { onPick: (personId: string, mfa: boolean) => void }) {
  const t = useTranslations();
  const theme = useTheme();
  const [mfa, setMfa] = useState(false);
  const personas = useQuery({ queryKey: ["dev", "personas"], queryFn: fetchPersonas });
  if (!personas.data) return personas.isError ? <Muted>{t("login.dev.empty")}</Muted> : null;
  const withLogin = personas.data.personas.filter((p) => p.hasAccount || p.description);
  return (
    <View style={{ gap: theme.space(4) }} testID="persona-picker">
      <Body style={{ fontWeight: "700" }}>{t("login.dev.title")}</Body>
      <Muted>{t("login.dev.hint")}</Muted>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(3) }}>
        <Switch
          value={mfa}
          onValueChange={setMfa}
          accessibilityLabel={t("login.dev.mfa")}
          testID="persona-mfa"
        />
        <Body style={{ flex: 1 }}>{t("login.dev.mfa")}</Body>
      </View>
      {groupByClub(withLogin, t("login.dev.noClub")).map((group) => (
        <Section key={group.key} title={group.name}>
          {group.entries.map(({ persona, roles }, index) => (
            <Row
              key={persona.person.id}
              onPress={() => onPick(persona.person.id, mfa)}
              accessibilityLabel={t("login.dev.loginAs", { name: personLabel(persona.person) })}
              last={index === group.entries.length - 1}
              testID={`persona-${persona.person.id}`}
            >
              <Body style={{ fontWeight: "600" }}>{personLabel(persona.person)}</Body>
              {persona.description ? <Muted>{persona.description}</Muted> : null}
              {roles.length > 0 ? (
                <Muted>
                  {t("login.dev.roles", {
                    roles: roles.map((role) => t(enumKey("roles", role))).join(", "),
                  })}
                </Muted>
              ) : null}
            </Row>
          ))}
        </Section>
      ))}
    </View>
  );
}
