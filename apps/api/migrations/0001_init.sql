-- Better Auth's tables, the role on each user, and the owner's invitations.
CREATE TABLE `user` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `email` text NOT NULL,
  `email_verified` integer DEFAULT false NOT NULL,
  `image` text,
  `role` text DEFAULT 'accountant' NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);

CREATE TABLE `session` (
  `id` text PRIMARY KEY NOT NULL,
  `expires_at` integer NOT NULL,
  `token` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `ip_address` text,
  `user_agent` text,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade
);
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);

CREATE TABLE `account` (
  `id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `access_token` text,
  `refresh_token` text,
  `id_token` text,
  `access_token_expires_at` integer,
  `refresh_token_expires_at` integer,
  `scope` text,
  `password` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);

CREATE TABLE `verification` (
  `id` text PRIMARY KEY NOT NULL,
  `identifier` text NOT NULL,
  `value` text NOT NULL,
  `expires_at` integer NOT NULL,
  `created_at` integer,
  `updated_at` integer
);

CREATE TABLE `invitation` (
  `email` text PRIMARY KEY NOT NULL,
  `role` text DEFAULT 'accountant' NOT NULL,
  `invited_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `accepted_at` integer
);
