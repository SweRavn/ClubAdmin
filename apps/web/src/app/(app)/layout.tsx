// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";

import { AppFrame } from "../../components/app-frame.tsx";

export default function SignedInLayout({ children }: { children: ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
