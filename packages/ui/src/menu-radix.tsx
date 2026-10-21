// SPDX-License-Identifier: AGPL-3.0-only
"use client";
// The Radix UI drop-down menu behind Menu (menu.tsx), loaded on first use:
// arrow keys, type-ahead, Escape, focus return. Items are links or buttons
// that submit a form elsewhere on the page (the content is in a portal,
// outside any form).

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

import { ChevronDown, type MenuProps, triggerClass } from "./menu-trigger.tsx";

const itemClass =
  "flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-3 py-2 text-left text-sm outline-none data-[highlighted]:bg-accent-soft";

export function RadixMenu({ label, trigger, items, testId }: MenuProps) {
  return (
    // Opens at once: it is mounted by the first click on the plain trigger.
    // Non-modal: the modal variant locks page scrolling by injecting a <style>
    // element without the CSP nonce (react-remove-scroll).
    <DropdownMenu.Root modal={false} defaultOpen>
      <DropdownMenu.Trigger aria-label={label} data-testid={testId} className={triggerClass}>
        {trigger}
        <ChevronDown />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-border bg-raised p-1 text-fg shadow-lg"
        >
          {items.map((item) => {
            if (item.kind === "separator")
              return <DropdownMenu.Separator key={item.key} className="my-1 h-px bg-border" />;
            if (item.kind === "link")
              return (
                <DropdownMenu.Item key={item.key} asChild>
                  <a
                    href={item.href}
                    className={itemClass}
                    aria-current={item.current ? "true" : undefined}
                  >
                    {item.label}
                  </a>
                </DropdownMenu.Item>
              );
            return (
              <DropdownMenu.Item
                key={item.key}
                asChild
                // The menu closes (and unmounts) on select, before a native
                // click would submit: submit explicitly, with this button as submitter.
                onSelect={(event) => {
                  const button = event.currentTarget as HTMLButtonElement;
                  button.form?.requestSubmit(button);
                }}
              >
                <button
                  type="submit"
                  form={item.form}
                  name={item.name}
                  value={item.value}
                  className={itemClass}
                >
                  {item.label}
                </button>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
