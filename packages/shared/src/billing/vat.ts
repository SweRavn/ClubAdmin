// SPDX-License-Identifier: AGPL-3.0-only
// Which VAT applies to a subscription invoice (P1.13, ADR 0045; tested per
// case). The seller is the ClubAdmin service (BILLING_SELLER_*), the buyer a
// club. Rates come from configuration, not code.

/** EU member states (ISO 3166-1 alpha-2) for reverse charge. */
const EU = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export type VatNote = "none" | "reverse_charge" | "outside_scope";

export interface VatDecision {
  rateBp: number;
  note: VatNote;
}

export function vatFor(
  seller: { country: string; vatRateBp: number },
  buyer: { country: string; vatNumber: string | null },
): VatDecision {
  const sellerCountry = seller.country.toUpperCase();
  const buyerCountry = buyer.country.toUpperCase();
  // Domestic: the seller's VAT.
  if (buyerCountry === sellerCountry) return { rateBp: seller.vatRateBp, note: "none" };
  // Another EU country with a VAT number: the buyer accounts for it.
  if (EU.has(sellerCountry) && EU.has(buyerCountry) && buyer.vatNumber) {
    return { rateBp: 0, note: "reverse_charge" };
  }
  // Outside the EU (e.g. Norway): not Swedish VAT; the note says so.
  if (EU.has(sellerCountry) && !EU.has(buyerCountry)) {
    return { rateBp: 0, note: "outside_scope" };
  }
  // An EU buyer without a VAT number pays the seller's VAT.
  return { rateBp: seller.vatRateBp, note: "none" };
}
