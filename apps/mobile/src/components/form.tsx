// SPDX-License-Identifier: AGPL-3.0-only
// Form parts for the app's own forms (P2.7g): a labelled field with its
// error under it, text, date and time with the phone's own pickers, a
// choice of a few options, a switch. Errors come from the API's problem
// details (RFC 9457): each field's code next to the field, as the web
// does (P2.7c), and the form's own code (`detail`) above the button.

import { ApiError } from "@clubadmin/api-client";
import { enumKey } from "@clubadmin/i18n";
import DateTimePicker, { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { onlineManager } from "@tanstack/react-query";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, Switch, Text, TextInput, View } from "react-native";
import { useTranslations } from "use-intl";

import { useTheme } from "../theme.ts";
import { Body, Muted } from "./ui.tsx";

/** The form's and each field's error codes from a failed request. */
export interface FormErrors {
  /** The problem's detail code (translated with joinErrors), or "failed". */
  form: string | null;
  /** By the request field's first path segment (`startsAt`, `title`). */
  fields: Record<string, string>;
}

/** What went wrong, by field (the first code of each), from an ApiError or none. */
export function formErrorsOf(error: unknown): FormErrors {
  if (!error) return { form: null, fields: {} };
  if (!(error instanceof ApiError)) return { form: "failed", fields: {} };
  const fields: Record<string, string> = {};
  for (const issue of error.problem?.errors ?? []) {
    const name = issue.path.split(/[.[\]]+/).find(Boolean);
    if (name && !(name in fields)) fields[name] = issue.code;
  }
  const detail = error.problem?.detail;
  const form = detail && /^[a-z0-9_]+$/.test(detail) ? detail : (error.type ?? "failed");
  return { form, fields };
}

/** Joins locally found field errors with the API's (local ones first). */
export function mergeErrors(local: Record<string, string>, remote: FormErrors): FormErrors {
  return { form: remote.form, fields: { ...remote.fields, ...local } };
}

/** The translated message of a field's code: its own, the form error's, else a general one. */
export function useFieldMessage() {
  const t = useTranslations();
  return (code: string) => {
    const own = enumKey("fieldErrors", code);
    if (own !== "common.other") return t(own);
    const form = enumKey("joinErrors", code);
    return t(form !== "common.other" ? form : "fieldErrors.invalid");
  };
}

/** The form's error above its button; with field errors, how many are marked. */
export function FormError({ errors }: { errors: FormErrors }) {
  const t = useTranslations();
  const theme = useTheme();
  const marked = Object.keys(errors.fields).length;
  if (!errors.form && marked === 0) return null;
  const key = errors.form ? enumKey("joinErrors", errors.form) : "common.other";
  const text =
    key !== "common.other" && errors.form !== "invalid_input" && errors.form !== "validation"
      ? t(key)
      : marked > 0
        ? t("fieldErrors.summary", { count: marked })
        : t("joinErrors.failed");
  return (
    <Text
      accessibilityRole="alert"
      testID="form-error"
      style={{ color: theme.colors.danger, fontWeight: "600" }}
    >
      {text}
    </Text>
  );
}

/** A label, the field and its error. */
export function Field({
  label,
  hint,
  error,
  name,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /** For the error's testID (`field-error-<name>`). */
  name: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  const message = useFieldMessage();
  return (
    <View style={{ gap: theme.space(1), paddingVertical: theme.space(1) }}>
      <Body style={{ fontWeight: "600" }}>{label}</Body>
      {children}
      {hint ? <Muted>{hint}</Muted> : null}
      {error ? (
        <Text style={{ color: theme.colors.danger }} testID={`field-error-${name}`}>
          {message(error)}
        </Text>
      ) : null}
    </View>
  );
}

export function TextField({
  label,
  value,
  onChange,
  name,
  error,
  hint,
  multiline,
  maxLength,
  keyboardType,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  name: string;
  error?: string | undefined;
  hint?: string | undefined;
  multiline?: boolean;
  maxLength?: number;
  keyboardType?: "default" | "number-pad";
  placeholder?: string;
}) {
  const theme = useTheme();
  return (
    <Field label={label} hint={hint} error={error} name={name}>
      <TextInput
        value={value}
        onChangeText={onChange}
        accessibilityLabel={label}
        multiline={multiline}
        maxLength={maxLength}
        keyboardType={keyboardType ?? "default"}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.muted}
        testID={`field-${name}`}
        style={{
          borderWidth: 1,
          borderColor: error ? theme.colors.danger : theme.colors.border,
          borderRadius: 8,
          padding: theme.space(3),
          minHeight: multiline ? 96 : theme.touch,
          textAlignVertical: multiline ? "top" : "center",
          color: theme.colors.fg,
        }}
      />
    </Field>
  );
}

/** "YYYY-MM-DD" and "HH:MM" as a Date whose local parts are those (for the picker). */
function pickerDate(date: string, time: string): Date {
  const [y, m, d] = (date || "2000-01-01").split("-").map(Number) as [number, number, number];
  const [h, mi] = (time || "12:00").split(":").map(Number) as [number, number];
  return new Date(y, m - 1, d, h, mi);
}
const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * A date ("YYYY-MM-DD") or time ("HH:MM") in the club's time zone, chosen
 * with the phone's picker: Android's dialog, iOS's inline picker. Shown as
 * the value itself; optional fields can be cleared.
 */
export function DateTimeField({
  label,
  mode,
  value,
  onChange,
  name,
  error,
  hint,
  optional,
  date,
}: {
  label: string;
  mode: "date" | "time";
  value: string;
  onChange: (value: string) => void;
  name: string;
  error?: string | undefined;
  hint?: string | undefined;
  optional?: boolean;
  /** For a time: the day it belongs to (only for the picker's start value). */
  date?: string;
}) {
  const t = useTranslations();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const current =
    mode === "date" ? pickerDate(value, "12:00") : pickerDate(date ?? "", value || "18:00");
  const pick = (picked: Date | undefined) => {
    if (picked) onChange(mode === "date" ? dateOf(picked) : timeOf(picked));
  };
  const press = () => {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: current,
        mode,
        is24Hour: true,
        onChange: (event, picked) => {
          if (event.type === "set") pick(picked);
        },
      });
    } else {
      setOpen(!open);
    }
  };
  return (
    <Field label={label} hint={hint} error={error} name={name}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space(2) }}>
        <Pressable
          onPress={press}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value || t("activities.notGiven")}`}
          testID={`field-${name}`}
          style={{
            flex: 1,
            minHeight: theme.touch,
            justifyContent: "center",
            paddingHorizontal: theme.space(3),
            borderWidth: 1,
            borderColor: error ? theme.colors.danger : theme.colors.border,
            borderRadius: 8,
          }}
        >
          <Text style={{ color: value ? theme.colors.fg : theme.colors.muted, fontSize: 16 }}>
            {value || t("activities.notGiven")}
          </Text>
        </Pressable>
        {optional && value ? (
          <Pressable
            onPress={() => onChange("")}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.clear")}
            hitSlop={12}
            testID={`field-${name}-clear`}
          >
            <Text style={{ color: theme.colors.accent, fontWeight: "600" }}>
              {t("mobile.clear")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {open && Platform.OS !== "android" ? (
        <DateTimePicker
          value={current}
          mode={mode}
          display={mode === "date" ? "inline" : "spinner"}
          onChange={(_event, picked) => pick(picked)}
        />
      ) : null}
    </Field>
  );
}

/** One of a few options as buttons (a radio group). */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  name,
  error,
  hint,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  name: string;
  error?: string | undefined;
  hint?: string | undefined;
}) {
  const theme = useTheme();
  return (
    <Field label={label} hint={hint} error={error} name={name}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) }}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => onChange(o.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              accessibilityLabel={o.label}
              testID={`${name}-${o.value || "none"}`}
              style={{
                minHeight: theme.touch,
                paddingHorizontal: theme.space(3),
                justifyContent: "center",
                borderRadius: 8,
                borderWidth: 1,
                borderColor: selected ? theme.colors.accent : theme.colors.border,
                backgroundColor: selected ? theme.colors.accent : "transparent",
              }}
            >
              <Text
                style={{
                  color: selected ? theme.colors.accentFg : theme.colors.fg,
                  fontWeight: "600",
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Field>
  );
}

export function SwitchField({
  label,
  value,
  onChange,
  name,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  name: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: theme.space(2),
        minHeight: theme.touch,
      }}
    >
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} testID={name} />
      <Body style={{ flex: 1 }}>{label}</Body>
    </View>
  );
}

/** Whether the phone is online (TanStack Query's view, fed by NetInfo). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  );
}
