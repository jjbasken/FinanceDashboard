CREATE TABLE `account_folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` integer NOT NULL,
	`name` text NOT NULL,
	`section` text NOT NULL,
	`parent_id` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `account_folders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_folders_household_idx` ON `account_folders` (`household_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `folder_id` integer REFERENCES account_folders(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `categories` ADD `for_next_month` integer DEFAULT false NOT NULL;