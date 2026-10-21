// SPDX-License-Identifier: AGPL-3.0-only
// The login page moved to /login (P0.9); old links keep working.

import { type NextRequest, type NextResponse } from "next/server";

import { redirectTo } from "../../../server/http.ts";

export function GET(request: NextRequest): NextResponse {
  return redirectTo(`/login${request.nextUrl.search}`, 308);
}
