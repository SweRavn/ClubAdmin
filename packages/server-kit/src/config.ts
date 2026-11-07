// SPDX-License-Identifier: AGPL-3.0-only
// Typed configuration from environment variables, validated once at startup.

import { ENTITLEMENT_FEATURES, featureFlagName, z } from "@clubadmin/shared";

export class ConfigError extends Error {
  readonly issues: { variable: string; message: string }[];

  constructor(issues: { variable: string; message: string }[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i.variable}: ${i.message}`).join("\n")}\n` +
        "See .env.example for all variables.",
    );
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** "true"/"false"/"1"/"0" (case-insensitive) → boolean. */
export const envBoolean = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0", "TRUE", "FALSE", "True", "False"])
    .default(defaultValue ? "true" : "false")
    .transform((v) => v === "true" || v === "1" || v.toLowerCase() === "true");

/** Comma-separated list → string[]. */
export const envList = (defaultValue = "") =>
  z
    .string()
    .default(defaultValue)
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

/** Settings every server process shares (see docs/hosting-and-billing.md). */
export const baseConfigShape = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DEPLOYMENT_MODE: z.enum(["self_hosted", "hosted"]).default("self_hosted"),
  BILLING_ENABLED: envBoolean(false),
  /** Plan key for new clubs and clubs without a subscription (billing on). */
  BILLING_DEFAULT_PLAN: z
    .string()
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
    .default("free"),
  /** Length of the trial a new club gets on the hosted service (billing on). */
  BILLING_TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(30),
  /** Plan of the trial (P1.13; default: BILLING_DEFAULT_PLAN, as before). */
  BILLING_TRIAL_PLAN: z
    .string()
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/)
    .optional(),
  // The invoicing entity (P1.13, ADR 0045): required with billing on.
  BILLING_SELLER_NAME: z.string().min(1).optional(),
  BILLING_SELLER_ORGANIZATION_NUMBER: z.string().min(1).optional(),
  BILLING_SELLER_VAT_NUMBER: z.string().min(1).optional(),
  BILLING_SELLER_STREET: z.string().min(1).optional(),
  BILLING_SELLER_POSTAL_CODE: z.string().min(1).optional(),
  BILLING_SELLER_CITY: z.string().min(1).optional(),
  BILLING_SELLER_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("SE"),
  BILLING_SELLER_EMAIL: z.email().optional(),
  BILLING_SELLER_BANKGIRO: z
    .string()
    .regex(/^\d{3,4}-\d{4}$/, "bankgiro number like 123-4567")
    .optional(),
  /** "Godkänd för F-skatt" on invoices. */
  BILLING_SELLER_F_TAX: envBoolean(false),
  BILLING_INVOICE_PREFIX: z
    .string()
    .regex(/^[A-Z0-9-]{1,12}$/)
    .default("CA-"),
  /** The seller's VAT rate in basis points (2500 = 25 %). */
  BILLING_VAT_RATE_BP: z.coerce.number().int().min(0).max(10_000).default(2500),
  BILLING_PAYMENT_TERMS_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  /** Terms of service and DPA a club manager accepts when choosing a paid plan. */
  BILLING_TERMS_VERSION: z.string().min(1).default("2026-11"),
  BILLING_TERMS_URL: z.url().optional(),
  /** Invoice emails also link to the invoice page (login required); the PDF is always attached. */
  BILLING_INVOICE_EMAIL_LINK: envBoolean(false),
  /** FEATURE_<KEY>=false turns a feature off for the whole installation (entitlements). */
  ...(Object.fromEntries(
    ENTITLEMENT_FEATURES.map((feature) => [featureFlagName(feature), envBoolean(true)]),
  ) as Record<
    `FEATURE_${Uppercase<(typeof ENTITLEMENT_FEATURES)[number]>}`,
    ReturnType<typeof envBoolean>
  >),
  USER_SIGNUP: z.enum(["open", "invite_only"]).default("open"),
  CLUB_CREATION: z.enum(["open", "approval", "operators_only"]).optional(),
  /** Derives the tokens of email invitations (api and worker; at least 32 characters, ADR 0032). */
  INVITATION_TOKEN_KEY: z.string().min(32).optional(),
  DEFAULT_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/, "two-letter country code")
    .default("SE"),
  APP_VERSION: z.string().default("0.0.0"),
  GIT_COMMIT: z.string().default("unknown"),
  SOURCE_URL: z.url().default("https://github.com/SweRavn/ClubAdmin"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  /** Record history kept for this many months (ADR 0017). */
  HISTORY_RETENTION_MONTHS: z.coerce.number().int().min(1).default(24),
  /** Audit events kept for this many months (P1.8a, audit:retention; at least 12). */
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().min(12).default(24),
  /**
   * People without a login and without any relationship are kept this many
   * months in case a club or a guardian links them again, then erased
   * (P1.8a, privacy:retention; at least 12).
   */
  ORPHAN_RETENTION_MONTHS: z.coerce.number().int().min(12).default(36),
} as const;

export function parseConfig<T extends z.ZodType>(
  schema: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<T> {
  // Empty strings count as "not set", so defaults apply.
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => ({
        variable: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** The invoicing entity from the configuration (P1.13); printed on every invoice. */
export interface BillingSeller {
  name: string;
  organizationNumber: string;
  vatNumber: string | null;
  address: { street: string; postalCode: string; city: string; country: string };
  email: string | null;
  bankgiro: string;
  fTax: boolean;
  vatRateBp: number;
}

type SellerConfig = {
  [
    K in
      | "BILLING_SELLER_NAME"
      | "BILLING_SELLER_ORGANIZATION_NUMBER"
      | "BILLING_SELLER_VAT_NUMBER"
      | "BILLING_SELLER_STREET"
      | "BILLING_SELLER_POSTAL_CODE"
      | "BILLING_SELLER_CITY"
      | "BILLING_SELLER_EMAIL"
      | "BILLING_SELLER_BANKGIRO"
  ]?: string | undefined;
} & { BILLING_SELLER_COUNTRY: string; BILLING_SELLER_F_TAX: boolean; BILLING_VAT_RATE_BP: number };

const REQUIRED_SELLER = [
  "BILLING_SELLER_NAME",
  "BILLING_SELLER_ORGANIZATION_NUMBER",
  "BILLING_SELLER_STREET",
  "BILLING_SELLER_POSTAL_CODE",
  "BILLING_SELLER_CITY",
  "BILLING_SELLER_BANKGIRO",
] as const;

/**
 * Missing seller settings while billing is on in production (the API and the
 * worker refuse to start). Development and tests use DEMO_SELLER.
 */
export function billingSellerIssues(
  config: SellerConfig & { BILLING_ENABLED: boolean; NODE_ENV: string },
): { variable: string; message: string }[] {
  if (!config.BILLING_ENABLED || config.NODE_ENV !== "production") return [];
  return REQUIRED_SELLER.filter((k) => !config[k]).map((variable) => ({
    variable,
    message: "required while BILLING_ENABLED is on",
  }));
}

/** A fictional seller for development and tests (never a real company or bankgiro). */
export const DEMO_SELLER: BillingSeller = {
  name: "Exempelbolaget ClubAdmin AB (fiktivt)",
  organizationNumber: "559999-9999",
  vatNumber: "SE559999999901",
  address: { street: "Exempelgatan 1", postalCode: "111 11", city: "Stockholm", country: "SE" },
  email: "faktura@clubadmin.invalid",
  bankgiro: "000-0000",
  fTax: true,
  vatRateBp: 2500,
};

/** The configured seller, or the demo seller outside production. */
export function billingSeller(config: SellerConfig & { NODE_ENV: string }): BillingSeller | null {
  if (REQUIRED_SELLER.some((k) => !config[k])) {
    return config.NODE_ENV === "production"
      ? null
      : { ...DEMO_SELLER, vatRateBp: config.BILLING_VAT_RATE_BP };
  }
  return {
    name: config.BILLING_SELLER_NAME!,
    organizationNumber: config.BILLING_SELLER_ORGANIZATION_NUMBER!,
    vatNumber: config.BILLING_SELLER_VAT_NUMBER ?? null,
    address: {
      street: config.BILLING_SELLER_STREET!,
      postalCode: config.BILLING_SELLER_POSTAL_CODE!,
      city: config.BILLING_SELLER_CITY!,
      country: config.BILLING_SELLER_COUNTRY,
    },
    email: config.BILLING_SELLER_EMAIL ?? null,
    bankgiro: config.BILLING_SELLER_BANKGIRO!,
    fTax: config.BILLING_SELLER_F_TAX,
    vatRateBp: config.BILLING_VAT_RATE_BP,
  };
}
