// SPDX-License-Identifier: AGPL-3.0-only
// Phone and address (P2.7d, ADR 0057): the person's own profile, a ward's
// profile (a guardian acting for them) and a member's profile for the club's
// registrars (scope "club", second factor). Saved in place (ADR 0055); an
// empty address removes it. A protected person stores no address.
import type { PersonProfile } from "@clubadmin/shared";
import { getTranslations } from "next-intl/server";

import { ActionForm, buttonClass, inputClass } from "./action-form.tsx";

export async function ContactForm({
  personId,
  phone,
  address,
  scope,
  clubId,
  protectedIdentity = false,
}: {
  personId: string;
  phone: string | null | undefined;
  address: PersonProfile["address"];
  /** "self": the person or a guardian; "club": a registrar for clubId. */
  scope: "self" | "club";
  clubId?: string | null | undefined;
  protectedIdentity?: boolean;
}) {
  const t = await getTranslations();
  return (
    <ActionForm action="update-contact" className="space-y-3" testId="contact-form">
      <input type="hidden" name="personId" value={personId} />
      <input type="hidden" name="scope" value={scope} />
      {clubId ? <input type="hidden" name="clubId" value={clubId} /> : null}
      <label className="block space-y-1">
        <span className="font-medium">{t("contact.phone")}</span>
        <input
          type="tel"
          name="phone"
          autoComplete={scope === "self" ? "tel" : "off"}
          defaultValue={phone ?? ""}
          className={inputClass}
          data-testid="contact-phone"
        />
      </label>
      {protectedIdentity ? (
        <p className="text-sm text-muted">{t("contact.protectedNoAddress")}</p>
      ) : (
        <fieldset className="space-y-2">
          <legend className="font-medium">{t("contact.address")}</legend>
          <input
            name="street"
            aria-label={t("contact.street")}
            placeholder={t("contact.street")}
            autoComplete={scope === "self" ? "street-address" : "off"}
            defaultValue={address?.street ?? ""}
            className={inputClass}
            data-testid="contact-street"
          />
          <div className="flex flex-wrap gap-2">
            <input
              name="postalCode"
              aria-label={t("contact.postalCode")}
              placeholder={t("contact.postalCode")}
              autoComplete={scope === "self" ? "postal-code" : "off"}
              defaultValue={address?.postalCode ?? ""}
              className={`${inputClass} w-32`}
              data-testid="contact-postalCode"
            />
            <input
              name="city"
              aria-label={t("contact.city")}
              placeholder={t("contact.city")}
              autoComplete={scope === "self" ? "address-level2" : "off"}
              defaultValue={address?.city ?? ""}
              className={`${inputClass} flex-1`}
              data-testid="contact-city"
            />
            <input
              name="country"
              aria-label={t("contact.country")}
              maxLength={2}
              defaultValue={address?.country ?? "SE"}
              className={`${inputClass} w-16 uppercase`}
            />
          </div>
        </fieldset>
      )}
      {scope === "club" ? <p className="text-sm text-muted">{t("contact.clubNote")}</p> : null}
      <button type="submit" className={buttonClass} data-testid="contact-save">
        {t("contact.save")}
      </button>
    </ActionForm>
  );
}
