# FinanceDashboard

A self-hosted family finance manager: Actual Budget-style envelope budgeting, investment tracking, and GnuCash import, with a separate login for each household member.

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

Go to **Settings → Import from GnuCash** and upload a **copy** of your book saved in the sqlite3 format. (In GnuCash, use File → Save As… and set the data format to "sqlite3". XML books aren't supported.) Before anything is saved, you can review how each GnuCash account maps:

- Bank, cash, credit card, asset and liability accounts become accounts. You choose whether each one is on budget.
- Income and expense accounts become categories. For example, `Expenses:Auto:Fuel` becomes the group "Auto" and the category "Fuel". Accounts that match an existing category name use that category.
- Equity is treated as opening balances. `Imbalance-*` and `Orphan-*` accounts are skipped, so their share of a transaction is imported as uncategorized.
- Stock and mutual fund accounts become investment holdings in the account their parent GnuCash account is imported into. Buys, sells and splits come in with their share counts, along with the book's price history.

The preview shows how many transactions will be imported and compares each account's balance with GnuCash's. You can import the same book again later: only transactions you haven't imported yet are added, and your previous mapping is remembered. A transaction you deleted here is not brought back. Each import can be undone from the same page.



```sh
cd docker
docker compose up -d --build
```

The app runs at http://localhost:8080. Its SQLite database is stored in `docker/data/`, which is the folder to back up.

### Configuration

All settings are optional. To change any of them, copy `.env.example` to `.env` at the repo root; it lists every option and explains each one. Both the dev scripts and `docker compose` read that file.

| Variable                  | Default (dev / Docker)       | Purpose                                              |
| ------------------------- | ---------------------------- | ---------------------------------------------------- |
| `PORT`                    | `3000` / `8080`              | HTTP port                                            |
| `DATA_DIR`                | `./data` / `/data`           | Folder that holds `finance.db`                       |
| `WEB_DIST`                | `apps/web/dist`              | Built web app served by the server                   |
| `COOKIE_SECURE`           | `false`                      | Set to `true` when the app is served over HTTPS      |
| `SEED_HOUSEHOLD_NAME`     | (unset)                      | First-boot seeding; see below                        |
| `SEED_OWNER_USERNAME`     | (unset)                      |                                                      |
| `SEED_OWNER_PASSWORD`     | (unset)                      |                                                      |
| `SEED_OWNER_DISPLAY_NAME` | the username                 |                                                      |

**Seeding the owner on first start.** If the database is empty, the server creates the household and the owner account from the `SEED_*` variables, so the setup page never appears. The household name, username and password must all be set; if only some are set, or a value is invalid, the server won't start. Seeding is skipped once any user exists, so you can remove `SEED_OWNER_PASSWORD` after the first start.

There are no signing secrets to configure, `JWT_SECRET` included. Sessions use random tokens that the server checks against hashes stored in the database.

**To reach the app from outside your home network,** put it behind a reverse proxy that handles HTTPS, such as Caddy or Traefik, and set `COOKIE_SECURE=true`.

## Contributing

`main` is protected, so all changes go through pull requests.
