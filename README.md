# FinanceDashboard

A self-hosted family finance manager: Actual Budget-style envelope budgeting, investment tracking, and GnuCash import, with a separate login for each household member.

> **Status:** milestone 1 (scaffold and auth) is done. Accounts, budgeting, GnuCash import, investments and reports are coming in later milestones.

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

When you open the app for the first time, it asks you to create your household and the owner account. To add your partner, go to **Settings → Create invite link** and send them the link. Each link works once and expires after 7 days.

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

| Variable        | Default  | Purpose                                                    |
| --------------- | -------- | ---------------------------------------------------------- |
| `PORT`          | `8080`   | HTTP port                                                  |
| `DATA_DIR`      | `/data`  | Folder that holds `finance.db`                             |
| `COOKIE_SECURE` | `false`  | Set to `true` when the app is served over HTTPS (recommended) |

**To reach the app from outside your home network,** put it behind a reverse proxy that handles HTTPS, such as Caddy or Traefik, and set `COOKIE_SECURE=true`.

## Contributing

`main` is protected, so all changes go through pull requests.
