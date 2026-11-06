-- An office's own address, <subdomain>.<APP_DOMAIN>. Set by an operator once its custom domain works; until then the office opens on the console.
ALTER TABLE `office` ADD COLUMN `subdomain` text;
CREATE UNIQUE INDEX `office_subdomain_unique` ON `office` (`subdomain`);
