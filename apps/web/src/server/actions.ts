// SPDX-License-Identifier: AGPL-3.0-only
// Form actions of the joining pages (P1.1): each turns a posted form into one
// API call and a redirect (success or `?error=<detail>` back to the form), so
// the pages work without client JavaScript. The route handler
// (app/actions/[action]/route.ts) checks the session and the CSRF token.

import {
  addChildInput,
  addMemberFormInput,
  GUARDIANSHIP_KINDS,
  GUARDIANSHIP_RIGHTS,
  type GuardianshipRight,
  isLinkedGuardianshipKind,
  isUuid,
  linkedPersonInput,
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

/** Checked rights of a relative or contact person (checkboxes named "right"). */
const rightsOf = (form: FormData): GuardianshipRight[] =>
  form
    .getAll("right")
    .filter((r): r is GuardianshipRight => (GUARDIANSHIP_RIGHTS as readonly unknown[]).includes(r));
const kindOf = (form: FormData) => {
  const kind = text(form, "kind");
  return (GUARDIANSHIP_KINDS as readonly string[]).includes(kind) ? kind : null;
};
const isLinked = isLinkedGuardianshipKind;
/** A person without login (name, phone) from the form's person fields. */
const newPerson = (form: FormData) => linkedPersonInput((name) => text(form, name));

/** Families (P1.3). */
const FAMILY_ACTIONS: Record<string, FormAction> = {
  "add-child": {
    call: (form) => {
      const country = text(form, "pinCountry");
      const pin = text(form, "personalIdentityNumber");
      return {
        path: "/api/v1/me/wards",
        method: "POST",
        body: addChildInput((name) => text(form, name), {
          kind: text(form, "kind") === "legal_guardian" ? "legal_guardian" : "parent",
          ...(pin ? { personalIdentityNumber: { country: country || "SE", value: pin } } : {}),
        }),
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "added", "1"),
  },
  "invite-guardian": {
    call: (form) => {
      const wardId = id(form, "wardId");
      const kind = kindOf(form);
      if (!wardId || !kind) return null;
      return {
        path:
          wardId === text(form, "selfId")
            ? "/api/v1/me/trusted-people"
            : `/api/v1/me/wards/${wardId}/guardian-invitations`,
        method: "POST",
        body: {
          email: text(form, "email"),
          kind,
          ...(isLinked(kind) ? { rights: rightsOf(form) } : {}),
        },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "invited", "1"),
  },
  "add-linked-person": {
    call: (form) => {
      const wardId = id(form, "wardId");
      const kind = kindOf(form);
      if (!wardId || !kind || !isLinked(kind)) return null;
      return {
        path:
          wardId === text(form, "selfId")
            ? "/api/v1/me/trusted-people"
            : `/api/v1/me/wards/${wardId}/guardians`,
        method: "POST",
        body: { person: newPerson(form), kind, rights: rightsOf(form) },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "linked", "1"),
  },
  "resend-guardian-invitation": {
    call: (form) => {
      const invitationId = id(form, "invitationId");
      return invitationId
        ? { path: `/api/v1/guardian-invitations/${invitationId}/resend`, method: "POST" }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "resent", "1"),
  },
  "revoke-guardian-invitation": {
    call: (form) => {
      const invitationId = id(form, "invitationId");
      return invitationId
        ? { path: `/api/v1/guardian-invitations/${invitationId}/revoke`, method: "POST" }
        : null;
    },
    done: (form) => back(form, "/me/family"),
  },
  "update-guardian-rights": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      return guardianshipId
        ? {
            path: `/api/v1/guardianships/${guardianshipId}`,
            method: "PATCH",
            body: { rights: rightsOf(form) },
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "updated", "1"),
  },
  "end-guardianship": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      if (!guardianshipId || text(form, "confirm") !== "on") return null;
      return { path: `/api/v1/guardianships/${guardianshipId}/end`, method: "POST" };
    },
    done: (form) => withParam(back(form, "/me/family"), "ended", "1"),
  },
  "accept-guardian-invitation": {
    call: (form) => {
      const token = text(form, "token");
      return token
        ? { path: "/api/v1/guardian-invitations/accept", method: "POST", body: { token } }
        : null;
    },
    done: (_form, result) =>
      (result as { suggestProtection?: boolean } | null)?.suggestProtection
        ? "/me/family?accepted=protected"
        : "/me/family?accepted=1",
  },
  "give-own-login": {
    call: (form) => {
      const personId = id(form, "personId");
      return personId
        ? {
            path: `/api/v1/people/${personId}/own-login-invitations`,
            method: "POST",
            body: { email: text(form, "email") },
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "ownLogin", "1"),
  },
  "merge-people": {
    call: (form) => {
      const personId = id(form, "personId");
      const duplicateId = id(form, "duplicatePersonId");
      const clubId = id(form, "clubId");
      if (!personId || !duplicateId) return null;
      return {
        path: `/api/v1/people/${personId}/merge${clubId ? `?clubId=${clubId}` : ""}`,
        method: "POST",
        body: { duplicatePersonId: duplicateId },
      };
    },
    done: (form) => withParam(back(form, "/me/family"), "merged", "1"),
  },
  "undo-merge": {
    call: (form) => {
      const mergeId = id(form, "mergeId");
      const clubId = id(form, "clubId");
      return mergeId
        ? {
            path: `/api/v1/people/merges/${mergeId}/undo${clubId ? `?clubId=${clubId}` : ""}`,
            method: "POST",
          }
        : null;
    },
    done: (form) => withParam(back(form, "/me/family"), "undone", "1"),
  },
  "adult-decision": {
    call: (form) => {
      const guardianshipId = id(form, "guardianshipId");
      const decision = text(form, "decision");
      if (!guardianshipId || (decision !== "keep" && decision !== "end")) return null;
      return {
        path: `/api/v1/me/adult-guardians/${guardianshipId}/decision`,
        method: "POST",
        body: { decision },
      };
    },
    done: (form) => withParam(back(form, "/me/family/adult"), "decided", "1"),
  },
  "club-add-guardian": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const personId = id(form, "personId");
      const kind = kindOf(form);
      if (!clubId || !personId || !kind) return null;
      const existing = id(form, "guardianPersonId");
      return {
        path: `/api/v1/clubs/${clubId}/members/${personId}/guardians`,
        method: "POST",
        body: {
          guardian: existing ? { personId: existing } : { person: newPerson(form) },
          kind,
          ...(isLinked(kind)
            ? { rights: rightsOf(form), consentNote: optional(text(form, "consentNote")) }
            : {}),
        },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
  "club-end-guardianship": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const guardianshipId = id(form, "guardianshipId");
      if (!clubId || !guardianshipId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/guardianships/${guardianshipId}/end`,
        method: "POST",
        body: { reason: optional(text(form, "reason")) },
      };
    },
    done: (form) => withParam(back(form), "updated", "1"),
  },
};

export const FORM_ACTIONS: Record<string, FormAction> = {
  ...FAMILY_ACTIONS,
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
  // Adding and importing members (P1.3b).
  "add-member": {
    call: (form) => {
      const clubId = id(form, "clubId");
      if (!clubId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/members`,
        method: "POST",
        body: addMemberFormInput(
          (name) => text(form, name),
          (name) => form.getAll(name).filter((v): v is string => typeof v === "string" && v !== ""),
        ),
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/members?added=1`,
  },
  "update-import-mapping": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      const columnMap: Record<string, string> = {};
      for (const [key, value] of form.entries()) {
        const column = /^column\.([0-9]{1,3})$/.exec(key);
        if (column && typeof value === "string" && value !== "") columnMap[column[1]!] = value;
      }
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/mapping`,
        method: "PUT",
        body: {
          columnMap,
          options: {
            membershipType: text(form, "membershipType") || "active",
            startDate: text(form, "startDate") || null,
            memberNumbers: text(form, "memberNumbers") === "keep" ? "keep" : "assign",
            sendInvitations: text(form, "sendInvitations") === "on",
            consentNote: text(form, "consentNote") || null,
          },
        },
      };
    },
    done: (form) => back(form),
  },
  "update-import-row": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      const rowNumber = text(form, "rowNumber");
      const action = text(form, "rowAction");
      if (!clubId || !importId || !/^[0-9]{1,6}$/.test(rowNumber)) return null;
      if (!["skip", "unskip", "same_person", "different_person"].includes(action)) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/rows/${rowNumber}`,
        method: "PATCH",
        body: { action },
      };
    },
    done: (form) => back(form),
  },
  "confirm-import": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/confirm`,
        method: "POST",
      };
    },
    done: (form) => back(form),
  },
  "cancel-import": {
    call: (form) => {
      const clubId = id(form, "clubId");
      const importId = id(form, "importId");
      if (!clubId || !importId) return null;
      return {
        path: `/api/v1/clubs/${clubId}/member-imports/${importId}/cancel`,
        method: "POST",
      };
    },
    done: (form) => `/clubs/${text(form, "clubId")}/members/import`,
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
