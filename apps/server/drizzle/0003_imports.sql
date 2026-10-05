CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`source` text NOT NULL,
	`file_name` text NOT NULL,
	`transaction_count` integer DEFAULT 0 NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`undone_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_batches_household_idx` ON `import_batches` (`household_id`);--> statement-breakpoint
CREATE TABLE `import_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`mapping` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_mappings_external_unique` ON `import_mappings` (`household_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `imported_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`batch_id` integer NOT NULL,
	`external_id` text NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imported_records_external_unique` ON `imported_records` (`household_id`,`external_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `import_batch_id` integer REFERENCES import_batches(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `categories` ADD `import_batch_id` integer REFERENCES import_batches(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `category_groups` ADD `import_batch_id` integer REFERENCES import_batches(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `payees` ADD `import_batch_id` integer REFERENCES import_batches(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `transactions` ADD `import_batch_id` integer REFERENCES import_batches(id) ON DELETE cascade;--> statement-breakpoint
CREATE INDEX `transactions_import_batch_idx` ON `transactions` (`import_batch_id`);