-- Offices purged while they had daily copies in India: the nightly run deletes those copies, and keeps the
-- row (with how many went and the last error) until none are left.
CREATE TABLE `backup_erasure` (
  `office_id` text PRIMARY KEY NOT NULL,
  `since` integer NOT NULL,
  `erased` integer DEFAULT 0 NOT NULL,
  `tries` integer DEFAULT 0 NOT NULL,
  `last_error` text
);
