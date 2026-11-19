-- Sign-in hardening: rate-limit counts shared by every isolate.
CREATE TABLE `rate_limit` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `count` integer NOT NULL,
  `last_request` integer NOT NULL
);
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);

-- Two-factor sign-in: the authenticator secret and backup codes (encrypted), and whether it is on.
ALTER TABLE `user` ADD `two_factor_enabled` integer DEFAULT false NOT NULL;
CREATE TABLE `two_factor` (
  `id` text PRIMARY KEY NOT NULL,
  `secret` text NOT NULL,
  `backup_codes` text NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `verified` integer DEFAULT true NOT NULL,
  `failed_verification_count` integer DEFAULT 0 NOT NULL,
  `locked_until` integer
);
CREATE UNIQUE INDEX `two_factor_user_unique` ON `two_factor` (`user_id`);

-- Step-up: when the password or a two-factor code was last typed again in a session.
ALTER TABLE `session` ADD `step_up_at` integer;
