// SPDX-License-Identifier: AGPL-3.0-only
// Every page of a group: the breadcrumb trail (P2.7b), Förening › Grupp › Sida.
import type { ReactNode } from "react";

import { Breadcrumbs } from "../../../../components/breadcrumbs.tsx";
import { getClub, getGroup } from "../../../../server/data.ts";

export default async function GroupLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = await params;
  const group = await getGroup(groupId);
  const club = await getClub(group.clubId);
  return (
    <>
      <Breadcrumbs
        club={{ id: club.id, name: club.name }}
        group={{ id: group.id, name: group.name }}
      />
      {children}
    </>
  );
}
