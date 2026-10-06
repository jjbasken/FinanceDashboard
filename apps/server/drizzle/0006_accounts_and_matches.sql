CREATE TABLE `import_matches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`previous_imported_id` text,
	`previous_cleared` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_matches_batch_idx` ON `import_matches` (`batch_id`);--> statement-breakpoint
ALTER TABLE `households` ADD `currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `disabled_at` text;