ALTER TABLE `accounts` ADD `owner_id` integer REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `in_budget` integer DEFAULT false NOT NULL;