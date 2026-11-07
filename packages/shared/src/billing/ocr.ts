// SPDX-License-Identifier: AGPL-3.0-only
// Bankgiro OCR references (P1.13): digits, a length digit and a Luhn
// ("modulus 10") check digit, so the bank refuses mistyped references.

/** The Luhn check digit of a string of digits. */
export function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export const isValidLuhn = (digits: string): boolean =>
  /^\d+$/.test(digits) && luhnCheckDigit(digits.slice(0, -1)) === Number(digits.at(-1));

/** An OCR reference from the digits of an invoice number (2–25 digits in all). */
export function ocrReference(invoiceNumber: string): string {
  const base = invoiceNumber.replace(/\D/g, "").slice(-21) || "0";
  const length = (base.length + 2) % 10;
  const withLength = `${base}${length}`;
  return `${withLength}${luhnCheckDigit(withLength)}`;
}
