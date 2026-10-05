# FinanceDashboard

A self-hosted family finance manager: Actual Budget-style envelope budgeting, investment tracking, and GnuCash import, with a separate login for each household member.

> **Status:** milestones 1–3 are done: scaffold and auth; the core ledger (accounts, categories, payees, and a keyboard-driven register with transfers, splits and reconciliation); and the envelope budget (monthly grid with Actual-style rollover). GnuCash import, investments and reports are coming in later milestones.

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

## Production (Docker)

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
