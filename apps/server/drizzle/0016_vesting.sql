CREATE TABLE `vesting_tranches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`investment_txn_id` integer NOT NULL,
	`date` text NOT NULL,
	`shares` integer NOT NULL,
	FOREIGN KEY (`investment_txn_id`) REFERENCES `investment_txns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vesting_tranches_txn_idx` ON `vesting_tranches` (`investment_txn_id`,`date`);