CREATE TABLE `budget_months` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`category_id` integer NOT NULL,
	`month` text NOT NULL,
	`amount` integer NOT NULL,
	`updated_by` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budget_months_category_month_unique` ON `budget_months` (`category_id`,`month`);--> statement-breakpoint
CREATE INDEX `budget_months_household_month_idx` ON `budget_months` (`household_id`,`month`);