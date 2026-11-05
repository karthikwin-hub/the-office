-- Which version of the terms and the privacy notice each person accepted, and from which country.
CREATE TABLE `consent` (
  `user_id` text NOT NULL REFERENCES `user`(`id`) ON DELETE cascade,
  `document` text NOT NULL,
  `version` text NOT NULL,
  `accepted_at` integer NOT NULL,
  `country` text,
  PRIMARY KEY (`user_id`, `document`, `version`)
);

-- A person asking for their account to be deleted. Kept after it is done, as the record that it was;
-- it names the address, not the account, so it outlives the account.
CREATE TABLE `rights_request` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `email` text NOT NULL,
  `kind` text NOT NULL,
  `status` text NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  `done_at` integer,
  `done_by` text
);
CREATE INDEX `rights_request_user` ON `rights_request` (`user_id`, `status`);
CREATE INDEX `rights_request_open` ON `rights_request` (`status`, `created_at`);
