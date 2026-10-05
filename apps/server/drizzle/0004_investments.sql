CREATE TABLE `investment_txns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`security_id` integer NOT NULL,
	`date` text NOT NULL,
	`action` text NOT NULL,
	`shares` integer NOT NULL,
	`price` integer DEFAULT 0 NOT NULL,
	`fees` integer DEFAULT 0 NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`transaction_id` integer,
	`notes` text DEFAULT '' NOT NULL,
	`imported_id` text,
	`import_batch_id` integer,
	`created_by` integer,
	`updated_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `investment_txns_account_idx` ON `investment_txns` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `investment_txns_security_idx` ON `investment_txns` (`security_id`,`date`);--> statement-breakpoint
CREATE UNIQUE INDEX `investment_txns_transaction_unique` ON `investment_txns` (`transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `investment_txns_imported_id_unique` ON `investment_txns` (`household_id`,`imported_id`);--> statement-breakpoint
CREATE TABLE `prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`security_id` integer NOT NULL,
	`date` text NOT NULL,
	`close` integer NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prices_security_date_unique` ON `prices` (`security_id`,`date`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`auto_price` integer DEFAULT false NOT NULL,
	`import_batch_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_household_symbol_unique` ON `securities` (`household_id`,`symbol`);