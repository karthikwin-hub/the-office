-- Many businesses on one Worker. Each office keeps its books in its own Durable Object;
-- these tables only say who belongs where and where inbound mail and webhooks go.

CREATE TABLE `office` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `slug` text NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_by` text,
  `created_at` integer NOT NULL,
  `deleted_at` integer
);
CREATE UNIQUE INDEX `office_slug_unique` ON `office` (`slug`);
CREATE INDEX `office_created_by` ON `office` (`created_by`, `created_at`);

CREATE TABLE `membership` (
  `office_id` text NOT NULL REFERENCES `office`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `role` text NOT NULL,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`office_id`, `user_id`)
);
CREATE INDEX `membership_user` ON `membership` (`user_id`);

ALTER TABLE `invitation` RENAME TO `invitation_single`;
CREATE TABLE `invitation` (
  `office_id` text NOT NULL REFERENCES `office`(`id`) ON DELETE cascade,
  `email` text NOT NULL,
  `role` text DEFAULT 'accountant' NOT NULL,
  `token_hash` text NOT NULL,
  `invited_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer NOT NULL,
  `accepted_at` integer,
  PRIMARY KEY (`office_id`, `email`)
);
CREATE UNIQUE INDEX `invitation_token_unique` ON `invitation` (`token_hash`);

CREATE TABLE `route` (
  `kind` text NOT NULL,
  `external_id` text NOT NULL,
  `office_id` text NOT NULL REFERENCES `office`(`id`) ON DELETE cascade,
  `created_at` integer NOT NULL,
  PRIMARY KEY (`kind`, `external_id`)
);
CREATE INDEX `route_office` ON `route` (`office_id`);

CREATE TABLE `wa_link` (
  `phone` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `active_office_id` text REFERENCES `office`(`id`) ON DELETE set null,
  `language` text DEFAULT 'auto' NOT NULL,
  `digest` integer DEFAULT 0 NOT NULL,
  `linked_at` integer NOT NULL
);
CREATE UNIQUE INDEX `wa_link_user` ON `wa_link` (`user_id`);

CREATE TABLE `wa_code` (
  `code` text PRIMARY KEY NOT NULL,
  `office_id` text NOT NULL REFERENCES `office`(`id`) ON DELETE cascade,
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `expires_at` integer NOT NULL
);
CREATE UNIQUE INDEX `wa_code_user` ON `wa_code` (`user_id`);

CREATE TABLE `wa_attempt` (
  `phone` text PRIMARY KEY NOT NULL,
  `failures` integer NOT NULL,
  `window_start` integer NOT NULL
);

CREATE TABLE `audit` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `office_id` text NOT NULL,
  `actor` text NOT NULL,
  `action` text NOT NULL,
  `detail` text,
  `at` integer NOT NULL
);
CREATE INDEX `audit_office` ON `audit` (`office_id`, `at`);

-- The office that was here before keeps its Durable Object name, its people and its old email-in address.
INSERT INTO `office` (`id`, `name`, `slug`, `status`, `created_by`, `created_at`)
  SELECT 'kaveri-electricals', 'Your business', 'kaveri-electricals', 'active', (SELECT `id` FROM `user` WHERE `role` = 'owner' LIMIT 1), unixepoch() * 1000
  WHERE EXISTS (SELECT 1 FROM `user`);
INSERT INTO `membership` (`office_id`, `user_id`, `role`, `created_at`)
  SELECT 'kaveri-electricals', `id`, `role`, unixepoch() * 1000 FROM `user`
  WHERE EXISTS (SELECT 1 FROM `office` WHERE `id` = 'kaveri-electricals');
INSERT INTO `route` (`kind`, `external_id`, `office_id`, `created_at`)
  SELECT 'email', 'bills@the-office.example', 'kaveri-electricals', unixepoch() * 1000
  WHERE EXISTS (SELECT 1 FROM `office` WHERE `id` = 'kaveri-electricals');
INSERT INTO `audit` (`office_id`, `actor`, `action`, `detail`, `at`)
  SELECT 'kaveri-electricals', 'system', 'office.migrated', 'Moved from the single-office deployment', unixepoch() * 1000
  WHERE EXISTS (SELECT 1 FROM `office` WHERE `id` = 'kaveri-electricals');
-- People already in that office signed up before addresses were checked.
UPDATE `user` SET `email_verified` = 1 WHERE `id` IN (SELECT `user_id` FROM `membership`);
-- Old invitations had no link to prove the address; the owner sends new ones.
DROP TABLE `invitation_single`;
