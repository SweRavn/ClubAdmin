// SPDX-License-Identifier: AGPL-3.0-only
// The current club: remembered per person (as on the web), else the first of
// my clubs. Its language and time zone feed the locale chain.

import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

import { type MyClub, useMyClubs } from "../api/queries.ts";
import { appSettings } from "../cache/settings.ts";
import { useSession } from "./session.tsx";

interface CurrentClub {
  club: MyClub | null;
  clubs: MyClub[];
  setClub: (clubId: string) => void;
}

const ClubContext = createContext<CurrentClub>({ club: null, clubs: [], setClub: () => undefined });

export const useCurrentClub = () => useContext(ClubContext);

export function ClubProvider({ children }: { children: ReactNode }) {
  const { personId } = useSession();
  const clubs = useMyClubs();
  const [chosen, setChosen] = useState<string | null>(() =>
    personId ? appSettings.lastClub(personId) : null,
  );
  const list = useMemo(() => clubs.data?.clubs ?? [], [clubs.data]);
  const club = list.find((entry) => entry.club.id === chosen) ?? list[0] ?? null;
  const setClub = useCallback(
    (clubId: string) => {
      setChosen(clubId);
      if (personId) appSettings.setLastClub(personId, clubId);
    },
    [personId],
  );
  const value = useMemo(() => ({ club, clubs: list, setClub }), [club, list, setClub]);
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}
