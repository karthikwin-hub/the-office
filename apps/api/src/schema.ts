import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Better Auth's tables. `role` is from the single-office days; memberships hold the role in each office now. */
export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role", { enum: ["owner", "accountant"] })
    .notNull()
    .default("accountant"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /** When the password or a two-factor code was last typed again in this session, for the riskier actions. */
  stepUpAt: integer("step_up_at", { mode: "timestamp" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});

/** Better Auth's rate-limit counts, one row per caller and path, shared by every isolate. */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

/** Better Auth's two-factor plugin: the authenticator secret and backup codes, both encrypted with BETTER_AUTH_SECRET. */
export const twoFactor = sqliteTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: integer("verified", { mode: "boolean" }).notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: integer("locked_until", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("two_factor_user_unique").on(t.userId)],
);

/* ---------- The control plane: who belongs to which office, and where inbound messages go. Times are epoch milliseconds. ---------- */

export const office = sqliteTable(
  "office",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status", { enum: ["active", "suspended", "deleting"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at"),
    country: text("country").notNull().default("IN"),
    currency: text("currency").notNull().default("INR"),
    locale: text("locale").notNull().default("en-IN"),
    timeZone: text("time_zone").notNull().default("Asia/Kolkata"),
    subdomain: text("subdomain"),
  },
  (t) => [
    uniqueIndex("office_slug_unique").on(t.slug),
    uniqueIndex("office_subdomain_unique").on(t.subdomain),
    index("office_created_by").on(t.createdBy, t.createdAt),
  ],
);

export const membership = sqliteTable(
  "membership",
  {
    officeId: text("office_id")
      .notNull()
      .references(() => office.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "accountant"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.officeId, t.userId] }), index("membership_user").on(t.userId)],
);

export const invitation = sqliteTable(
  "invitation",
  {
    officeId: text("office_id")
      .notNull()
      .references(() => office.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ["owner", "accountant"] })
      .notNull()
      .default("accountant"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
  },
  (t) => [primaryKey({ columns: [t.officeId, t.email] }), uniqueIndex("invitation_token_unique").on(t.tokenHash)],
);

export const route = sqliteTable(
  "route",
  {
    kind: text("kind", { enum: ["email", "wa_phone", "meta_page", "ig_account", "threads", "linkedin", "x"] }).notNull(),
    externalId: text("external_id").notNull(),
    officeId: text("office_id")
      .notNull()
      .references(() => office.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.externalId] }), index("route_office").on(t.officeId)],
);

export const waLink = sqliteTable(
  "wa_link",
  {
    phone: text("phone").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    activeOfficeId: text("active_office_id").references(() => office.id, { onDelete: "set null" }),
    language: text("language").notNull().default("auto"),
    digest: integer("digest", { mode: "boolean" }).notNull().default(false),
    linkedAt: integer("linked_at").notNull(),
  },
  (t) => [uniqueIndex("wa_link_user").on(t.userId)],
);

export const waCode = sqliteTable(
  "wa_code",
  {
    code: text("code").primaryKey(),
    officeId: text("office_id")
      .notNull()
      .references(() => office.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [uniqueIndex("wa_code_user").on(t.userId)],
);

export const waAttempt = sqliteTable("wa_attempt", {
  phone: text("phone").primaryKey(),
  failures: integer("failures").notNull(),
  windowStart: integer("window_start").notNull(),
});

/** Wrong WhatsApp JOIN codes from every number together, per hour (migration 0007). */
export const waAttemptAll = sqliteTable("wa_attempt_all", {
  windowStart: integer("window_start").primaryKey(),
  failures: integer("failures").notNull(),
});

/** Purged offices whose daily copies in India are still to be deleted (migration 0008). */
export const backupErasure = sqliteTable("backup_erasure", {
  officeId: text("office_id").primaryKey(),
  since: integer("since").notNull(),
  erased: integer("erased").notNull().default(0),
  tries: integer("tries").notNull().default(0),
  lastError: text("last_error"),
});

export const audit = sqliteTable(
  "audit",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    officeId: text("office_id").notNull(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    detail: text("detail"),
    at: integer("at").notNull(),
  },
  (t) => [index("audit_office").on(t.officeId, t.at)],
);
