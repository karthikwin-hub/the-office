-- Sign-in hardening: rate-limit counts shared by every isolate.
CREATE TABLE `rate_limit` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `count` integer NOT NULL,
  `last_request` integer NOT NULL
);
CREATE UNIQUE INDEX `rate_limit_key_unique` ON `rate_limit` (`key`);
