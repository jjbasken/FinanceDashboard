CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`on_budget` integer DEFAULT false NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`gnucash_guid` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_household_idx` ON `accounts` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_gnucash_guid_unique` ON `accounts` (`household_id`,`gnucash_guid`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`group_id` integer NOT NULL,
	`name` text NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `category_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `categories_group_idx` ON `categories` (`group_id`);--> statement-breakpoint
CREATE TABLE `category_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_income` integer DEFAULT false NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `category_groups_household_idx` ON `category_groups` (`household_id`);--> statement-breakpoint
CREATE TABLE `payees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`name` text NOT NULL,
	`transfer_account_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transfer_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payees_household_idx` ON `payees` (`household_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payees_transfer_account_unique` ON `payees` (`transfer_account_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`date` text NOT NULL,
	`amount` integer NOT NULL,
	`payee_id` integer,
	`category_id` integer,
	`notes` text DEFAULT '' NOT NULL,
	`cleared` integer DEFAULT false NOT NULL,
	`reconciled` integer DEFAULT false NOT NULL,
	`is_parent` integer DEFAULT false NOT NULL,
	`parent_id` integer,
	`transfer_id` integer,
	`imported_id` text,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payee_id`) REFERENCES `payees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transfer_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_parent_idx` ON `transactions` (`parent_id`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_payee_idx` ON `transactions` (`payee_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_imported_id_unique` ON `transactions` (`household_id`,`imported_id`);