ALTER TABLE `accounts` ADD `budget_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
INSERT INTO `accounts` (`household_id`, `name`, `type`, `on_budget`, `exclude_from_net_worth`, `budget_only`)
SELECT `id`, 'No account', 'cash', 1, 1, 1 FROM `households`;--> statement-breakpoint
INSERT INTO `payees` (`household_id`, `name`, `transfer_account_id`)
SELECT `household_id`, `name`, `id` FROM `accounts` WHERE `budget_only` = 1;
