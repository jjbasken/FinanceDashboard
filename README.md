# FinanceDashboard

A self-hosted family finance manager with an Actual Budget-style interface: monthly budgeting, a fast transaction register, investment tracking, reports, and imports from GnuCash and bank statements, with a separate login for each household member.

> **Status:** all six milestones are done: auth and households; the ledger (accounts, categories, payees, and a keyboard-driven register with transfers, splits and reconciliation); the monthly budget; GnuCash and bank-statement imports; investments with automatic daily prices; and reports, live updates between sessions, and nightly backups.

## Stack

- **Runtime:** [Bun](https://bun.sh) 1.3+, a monorepo built on Bun workspaces
- **Server** (`apps/server`): Hono, Drizzle ORM on `bun:sqlite`, and zod
- **Web** (`apps/web`): React, Vite, React Router, and TanStack Query
- **Shared** (`packages/shared`): zod schemas, API types, and money helpers. Money is stored as integer cents.

## Development

```sh
bun install
bun run dev:server   # API on http://localhost:3000 (data in ./data/finance.db)
bun run dev:web      # UI on http://localhost:5173 (proxies /api to :3000)
bun test             # all tests
bun run typecheck
```

When you open the app for the first time (unless you've seeded the owner; see below), it asks you to create your household and the owner account. To add your partner, go to **Settings → Create invite link** and send them the link. Each link works once and expires after 7 days.

### Database migrations

The schema is in `apps/server/src/db/schema.ts`. After you change it, run:

```sh
bun run db:generate
```

Migrations are stored in `apps/server/drizzle/` and run automatically when the server starts.

## Importing from GnuCash

Go to **Settings → Import transactions** and upload a **copy** of your book saved in the sqlite3 format. (In GnuCash, use File → Save As… and set the data format to "sqlite3". XML books aren't supported.) Before anything is saved, you can review how each GnuCash account maps:

- Bank, cash, credit card, asset and liability accounts become accounts. You choose whether each one is on budget.
- Income and expense accounts become categories. For example, `Expenses:Auto:Fuel` becomes the group "Auto" and the category "Fuel". Accounts that match an existing category name use that category.
- Equity is treated as opening balances. `Imbalance-*` and `Orphan-*` accounts are skipped, so their share of a transaction is imported as uncategorized.
- Stock and mutual fund accounts become investment holdings in the account their parent GnuCash account is imported into. Buys, sells and splits come in with their share counts, along with the book's price history.

The preview shows how many transactions will be imported and compares each account's balance with GnuCash's. You can import the same book again later: only transactions you haven't imported yet are added, and your previous mapping is remembered. A transaction you deleted here is not brought back. Each import can be undone from the same page.

## Importing bank statements

On the same Import page, choose an account and upload an **OFX/QFX** or **CSV** file from your bank:

- For a CSV, confirm which columns hold the date, payee and amount. The app guesses these, including separate debit and credit columns and the date format. Tick the box if spending shows as positive numbers, as is common for credit cards.
- Rows already imported from an earlier statement are skipped, so overlapping files are fine.
- If a row matches a transaction already in the account (same amount, within 3 days), the two are linked instead of duplicated. The existing transaction is marked cleared. This covers rows you entered by hand and rows brought in from GnuCash.
- New rows are cleared, and their category is suggested from the last time you used that payee. You can untick rows or change categories before importing.
- Each import can be undone from the Past imports list.

## Investments

Investments live in **Investment** accounts. An account's register holds its cash, and the **Investments** page tracks the securities it holds:

- Add a security by ticker. "Look up" fills in its name and type from Yahoo Finance. Then record buys, sells, dividends, reinvested dividends, splits, and shares moved in or out.
- Buys, sells and dividends add a linked cash entry to the account's register. You can only change that entry from the Investments page.
- Holdings show shares, the latest price, market value, average-cost basis and unrealized gain. Account balances and the sidebar total include market value.
- Prices are fetched daily from Yahoo Finance's public chart data, which needs no API key, and you can refresh them on demand. For anything Yahoo doesn't cover, enter prices by hand.

## Reports, live updates and backups

- **Reports**
  - **Net worth:** every account over time, with investments at market value.
  - **Cash flow:** income and spending per month, by category.
  - **Spending by category:** totals for any period.
- **Live updates:** when one of you changes something, the other's open window refreshes on its own.
- **Backups:** each night the server saves a copy of the database to `backups/` in the data folder and keeps the newest 14. The household owner can also download a fresh copy from **Settings → Backups**. To restore, stop the app, delete `finance.db-wal` and `finance.db-shm` if they exist, and replace `finance.db` with the backup file.

## Production (Docker)

```sh
cd docker
docker compose up -d --build
```

The app runs at http://localhost:8080. Its SQLite database is stored in `docker/data/`, and nightly backups go to `docker/data/backups/`. Copy that folder somewhere else (another disk, or cloud storage) to keep your data safe if this machine fails.

### Configuration

All settings are optional. To change any of them, copy `.env.example` to `.env` at the repo root; it lists every option and explains each one. Both the dev scripts and `docker compose` read that file.

| Variable                  | Default (dev / Docker)       | Purpose                                              |
| ------------------------- | ---------------------------- | ---------------------------------------------------- |
| `PORT`                    | `3000` / `8080`              | HTTP port                                            |
| `DATA_DIR`                | `./data` / `/data`           | Folder that holds `finance.db`                       |
| `WEB_DIST`                | `apps/web/dist`              | Built web app served by the server                   |
| `COOKIE_SECURE`           | `false`                      | Set to `true` when the app is served over HTTPS      |
| `PRICE_REFRESH`           | `on`                         | Set to `off` to stop fetching investment prices      |
| `BACKUP_KEEP`             | `14`                         | Nightly backups to keep; `0` turns them off          |
| `SEED_HOUSEHOLD_NAME`     | (unset)                      | First-boot seeding; see below                        |
| `SEED_OWNER_USERNAME`     | (unset)                      |                                                      |
| `SEED_OWNER_PASSWORD`     | (unset)                      |                                                      |
| `SEED_OWNER_DISPLAY_NAME` | the username                 |                                                      |

**Seeding the owner on first start.** If the database is empty, the server creates the household and the owner account from the `SEED_*` variables, so the setup page never appears. The household name, username and password must all be set; if only some are set, or a value is invalid, the server won't start. Seeding is skipped once any user exists, so you can remove `SEED_OWNER_PASSWORD` after the first start.

There are no signing secrets to configure, `JWT_SECRET` included. Sessions use random tokens that the server checks against hashes stored in the database.

**To reach the app from outside your home network,** put it behind a reverse proxy that handles HTTPS, such as Caddy or Traefik, and set `COOKIE_SECURE=true`.

## Contributing

`main` is protected, so all changes go through pull requests.
