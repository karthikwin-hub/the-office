-- Each office's country, currency, number and date style, and clock. Every office so far is in India.
ALTER TABLE `office` ADD COLUMN `country` text DEFAULT 'IN' NOT NULL;
ALTER TABLE `office` ADD COLUMN `currency` text DEFAULT 'INR' NOT NULL;
ALTER TABLE `office` ADD COLUMN `locale` text DEFAULT 'en-IN' NOT NULL;
ALTER TABLE `office` ADD COLUMN `time_zone` text DEFAULT 'Asia/Kolkata' NOT NULL;
