// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (P1.1): each turns a posted form into one
// API call and a redirect (success or `?error=<detail>` back to the form), so
// the pages work without client JavaScript. The route handler
// (app/actions/[action]/route.ts) checks the session and the CSRF token.

import {
  isUuid,
  MEMBER_EXPORT_COLUMNS,
  type MemberExportColumn,
  MEMBERSHIP_TYPES,
  RegisterFilterSchema,
} from "@clubadmin/shared";

import { safeReturnTo } from "./return-to.ts";

export interface ApiCall {
  path: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

export interface FormAction {
  /** The API call, or null if the form is not valid (then: back with ?error=invalid_input). */
  call(form: FormData): ApiCall | null;
  /** Where to go on success; `result` is the API's JSON body (or null). */
  done(form: FormData, result: unknown): string;
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};
const id = (form: FormData, name: string): string | null => {
  const value = text(form, name);
  return isUuid(value) ? value : null;
};
const optional = (value: string) => (value === "" ? undefined : value);
const back = (form: FormData, fallback = "/") => safeReturnTo(text(form, "back"), fallback);
const withParam = (path: string, key: string, value: string) =>
  `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;

/** The register filter carried by the export form (hidden fields, as in the list's URL). */
function exportFilter(form: FormData): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(RegisterFilterSchema.shape)) {
    const value = text(form, `filter.${key}`);
    if (!value) continue;
    raw[key] =
      key === "status" || key === "type"
        ? value.split(",")
        : key === "bornFrom" || key === "bornTo"
          ? Number(value)
          : value;
  }
  const parsed = RegisterFilterSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export const FORM_ACTIONS: Record<string, FormAction> = {
  "complete-profile": {
    call: (form) => ({
      path: "/api/v1/me/profile",
      method: "PUT",
      body: { birthDate: text(form, "birthDate") },
    }),
    done: (form) => back(form),
  },
  "request-join": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personIds = form
        .getAll("personId")
        .filter((v): v is string => typeof v === "string" && isUuid(v));
      if (!clubId || personIds.length === 0) return null;
      return {
        path: `/api/v1/clubs/${clubId}/join-requests`,
        method: "POST",
        body: { personIds, message: optional(text(form, "message")) },
      };
    },
    done: (_form, result) => {
      const items = (result as { items?: { result: string }[] } | null)?.items ?? [];
      return items.every((i) => i.result === "member") ? "/?joined=1" : "/?requested=1";
    },
  },
  "withdraw-join-request": {
    call: (form) => {
      const requestId = id(form, "joinRequestId");
      return requestId
        ? { path: `/api/v1/me/join-requests/${requestId}/withdraw`, method: "POST" }
        : null;
    },
    done: (form) => back(form),
  },
  "decide-join-request": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const requestId = id(form, "joinRequestId");
      const decision = text(form, "decision");
      if (!clubId || !requestId || (decision !== "approve" && decision !== "reject")) return null;
      return {
        path: `/api/v1/clubs/${clubId}/join-requests/${requestId}/decision`,
        method: "POST",
        body: { decision, message: optional(text(form, "message")) },
      };
    },
    done: (form) => withParam(back(form), "decided", text(form, "decision")),
  },
  "accept-invitation": {
    call: (form) => {
      const token = text(form, "token");
      const code = text(form, "code");
      if (!token && !code) return null;
      return {
        path: "/api/v1/invitations/accept",
        method: "POST",
        body: token ? { token } : { code },
      };
    },
    done: (_form, result) => {
      const clubId = (result as { clubId?: string } | null)?.clubId;
      return clubId && isUuid(clubId) ? `/clubs/${clubId}?welcome=1` : "/";
    },
  },
  "revoke-invitation": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const invitationId = id(form, "invitationId");
      return clubId && invitationId
        ? { path: `/api/v1/clubs/${clubId}/invitations/${invitationId}/revoke`, method: "POST" }
        : null;
    },
    done: (form) => back(form),
  },
  "create-club": {
    call: (form) => ({
      path: "/api/v1/clubs",
      method: "POST",
      body: {
        name: text(form, "name"),
        shortName: optional(text(form, "shortName")),
        slug: text(form, "slug"),
        country: text(form, "country"),
        joinPolicy: optional(text(form, "joinPolicy")),
      },
    }),
    done: (_form, result) => {
      const r = result as { outcome?: string; club?: { id: string } } | null;
      return r?.outcome === "created" && r.club && isUuid(r.club.id)
        ? `/clubs/${r.club.id}?created=1`
        : "/?creationRequested=1";
    },
  },
  "appoint-manager": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      return clubId && personId
        ? { path: `/api/v1/clubs/${clubId}/managers`, method: "POST", body: { personId } }
        : null;
    },
    done: (form) => back(form),
  },
  "remove-manager": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      return clubId && personId
        ? { path: `/api/v1/clubs/${clubId}/managers/${personId}`, method: "DELETE" }
        : null;
    },
    done: (form) => back(form),
  },
  "propose-handover": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const toPersonId = id(form, "personId");
      return clubId && toPersonId
        ? {
            path: `/api/v1/clubs/${clubId}/manager-handovers`,
            method: "POST",
            body: { toPersonId },
          }
        : null;
    },
    done: (form) => back(form),
  },
  // Member register (P1.2).
  "create-member-export": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const columns = form
        .getAll("column")
        .filter((c): c is MemberExportColumn =>
          (MEMBER_EXPORT_COLUMNS as readonly unknown[]).includes(c),
        );
      if (!clubId || columns.length === 0) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-exports`,
        method: "POST",
        body: {
          filter: exportFilter(form),
          columns,
          includeProtected: text(form, "includeProtected") === "on",
        },
      };
    },
    done: (form) => withParam(back(form), "requested", "1"),
  },
  "update-membership": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const change = text(form, "change");
      if (!clubId || !personId) return null;
      const path = `/api/v1/clubs/${clubId}/members/${personId}/membership`;
      if (change === "pause") return { path, method: "PATCH", body: { status: "paused" } };
      if (change === "resume") return { path, method: "PATCH", body: { status: "active" } };
      if (change === "end") {
        const endedOn = optional(text(form, "endedOn"));
        return { path, method: "PATCH", body: { status: "left", endedOn } };
      }
      const type = text(form, "membershipType");
      if (change === "type" && (MEMBERSHIP_TYPES as readonly string[]).includes(type)) {
        return { path, method: "PATCH", body: { membershipType: type } };
      }
      return null;
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "respond-handover": {
    call: (form) => {
      const handoverId = id(form, "handoverId");
      const response = text(form, "response");
      if (!handoverId || !["accept", "decline", "cancel"].includes(response)) return null;
      return { path: `/api/v1/manager-handovers/${handoverId}/${response}`, method: "POST" };
    },
    done: (form) => back(form),
  },
};
