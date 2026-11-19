// SPDX-License-Identifier: AGPL-3.0-only
// What is wrong in a form, next to each field (P2.7c). The action route puts
// the failed form's action (`invalid`) and its fields' codes (`fields`:
// `name:code;name:code`) in the page's address; ActionForm turns those of its
// own action into messages, and the form (with JavaScript) marks each field
// (`aria-invalid`, the message after it, linked by `aria-describedby`) and
// focuses the first. Without JavaScript the summary at the top lists them.

export interface FieldError {
  /** The field's `name` in the form. */
  name: string;
  message: string;
}

/** The fields' codes of the form `action`, from the page's query (else none). */
export function fieldCodesOf(
  query: URLSearchParams,
  action: string,
): { name: string; code: string }[] {
  if (query.get("invalid") !== action) return [];
  return (query.get("fields") ?? "")
    .split(";")
    .map((part) => {
      const at = part.lastIndexOf(":");
      return { name: part.slice(0, at), code: part.slice(at + 1) };
    })
    .filter((f) => f.name !== "" && f.code !== "");
}

const MARK = "data-field-error";

/** Marks the form's fields with their messages; returns the first marked field. */
export function markFields(
  form: HTMLFormElement,
  errors: readonly FieldError[],
): HTMLElement | null {
  for (const old of Array.from(form.querySelectorAll(`[${MARK}]`))) old.remove();
  for (const field of Array.from(form.querySelectorAll("[aria-invalid='true']"))) {
    field.removeAttribute("aria-invalid");
  }
  let first: HTMLElement | null = null;
  for (const [index, error] of errors.entries()) {
    const named = form.elements.namedItem(error.name);
    const field =
      named instanceof RadioNodeList
        ? (named[0] as HTMLElement | undefined)
        : (named as HTMLElement | null);
    if (!field) continue;
    const message = document.createElement("p");
    message.id = `${form.id || "form"}-error-${index}`;
    message.setAttribute(MARK, "");
    message.setAttribute("data-testid", "field-error");
    message.setAttribute("data-field", error.name);
    message.className = "mt-1 text-sm text-protected";
    message.textContent = error.message;
    field.setAttribute("aria-invalid", "true");
    const described = field.getAttribute("aria-describedby");
    field.setAttribute(
      "aria-describedby",
      [described, message.id].filter((x) => x && !x.includes("-error-")).join(" "),
    );
    (field.closest("label") ?? field).after(message);
    first ??= field;
  }
  return first;
}
