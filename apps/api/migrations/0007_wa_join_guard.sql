-- Wrong WhatsApp JOIN codes from every number together, per hour: guessing from many numbers runs out too.
CREATE TABLE `wa_attempt_all` (
  `window_start` integer PRIMARY KEY NOT NULL,
  `failures` integer NOT NULL
);
-- Codes are eight characters now; six-digit codes still waiting (15 minutes at most) are dropped. People ask for a new one.
DELETE FROM `wa_code`;
