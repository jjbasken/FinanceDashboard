# FinanceDashboard

A self-hosted family finance manager with an Actual Budget-style interface: monthly budgeting, a fast transaction register, investment tracking, reports, and imports from GnuCash and bank statements, with a separate login for each household member.

> **Status:** all six milestones are done: auth and households; the ledger (accounts, categories, payees, and a keyboard-driven register with transfers, splits and reconciliation); the monthly budget; GnuCash and bank-statement imports; investments with automatic daily prices; and reports, live updates between sessions, and nightly backups.

## Stack

- **Runtime:** [Bun](https://bun.sh) 1.3+, a monorepo built on Bun workspaces
- **Server** (`apps/server`): Hono, Drizzle ORM on `bun:sqlite`, and zod
- **Web** (`apps/web`): React, Vite, React Router, TanStack Query, and Recharts
- **Shared** (`packages/shared`): zod schemas, API types, and money helpers. Money is stored as integer cents, share quantities and prices as integer millionths, so there is no floating-point drift.

## Development

```sh
bun install
bun run dev:server   # API on http://localhost:3000 (data in ./data/finance.db)
bun run dev:web      # UI on http://localhost:5173 (proxies /api to :3000)
bun test             # all tests
bun run typecheck
```

To run a production build without Docker, use `bun run build` and then `bun run start` (it serves the API and the web app on one port).

When you open the app for the first time (unless you've seeded the owner; see below), it asks you to create your household and the owner account. To add your partner, go to **Settings → Create invite link** and send them the link. Each link works once and expires after 7 days.

### Database migrations

The schema is in `apps/server/src/db/schema.ts`. After you change it, run:

```sh
bun run db:generate
```

Migrations are stored in `apps/server/drizzle/` and run automatically when the server starts.

## Members and passwords

- **Your account** (Settings): change your password, which signs out your other devices, or sign out other devices on their own.
- **The owner** can set a new password for a member who has forgotten theirs, and remove a member. Removed members are signed out and can't sign in, but their name stays on what they entered; **Restore** brings them back.
- **If the owner forgets their password**, reset it on the server. This prints a new random password and signs them out everywhere:

  ```sh
  docker exec -u bun family-finance bun apps/server/src/cli.ts reset-password <username>
  # without Docker: bun apps/server/src/cli.ts reset-password <username>
  ```

- **Household name and currency** (owner, Settings → Household). Amounts are shown in the chosen currency; nothing is converted.

## Accounts and the register

Add accounts from the sidebar. On-budget accounts (checking, savings, cards, cash) feed the budget; off-budget accounts (investments, loans, other assets) count toward net worth only.

To group similar accounts, hover a sidebar section (For budget, Off budget or Investments) and click **+ Folder**. Folders can hold other folders, show the combined balance of what's in them, and collapse with a click; each browser remembers which ones you collapsed. Drag accounts and folders to arrange them: drop on an account to place it above, on the top of a folder to place it above, on the rest of the folder to put it inside, or on the section name to move it to the top level. On a phone, use **Move to folder** in the account's ⋯ menu. A folder only holds its own section's accounts, so moving an account on or off budget takes it out of its folder. Deleting a folder moves what was in it up a level.

Drag the sidebar's right edge to make it wider or narrower (or focus it and use the arrow keys); double-click the edge to reset it. Each browser remembers the width.

Each account's register is built for the keyboard:

- The top row is always ready for a new transaction. **Tab** moves between fields, **Enter** saves, and **Esc** clears the row.
- Click any field of an existing row to edit it. **Enter** saves and moves to the next row, **↑/↓** move between rows, and **Esc** cancels.
- Picking a "Transfer: …" payee creates a transfer, and both sides stay in sync. Picking "Split transaction" in the category field lets you divide a transaction across several categories.
- Click the circle on a row to mark it cleared. **Reconcile** compares the cleared balance with your statement and locks the cleared transactions once they match.
- Search finds transactions by payee, notes, category or amount. Searching "uncategorized" finds the ones that still need a category.
- Existing rows can be reached with **Tab**. On a row, **Enter** (or **F2**) edits it, **↑/↓** move between rows, and **Space** toggles cleared.

To tidy payee names, for example the ones bank statements bring in, use **Settings → Manage payees**. You can rename, merge several into one, delete, or delete all unused payees at once.

## Recurring bills

For bills that repeat (rent, utilities, daycare, insurance), go to **Bills** (on a phone: **More → Manage recurring bills**) and click **Add bill**. Pick the payee, amount, account and category, how often it repeats (every month, every week, every 2 weeks, or every year) and the first due date. The first due date sets the schedule: a monthly bill first due on the 15th comes back on the 15th, and one on the 31st falls on the last day of shorter months.

- **On the 1st of each month**, every bill due that month is added to its account's register with its due date, not cleared yet, so the month's bills are in the register from the start. An every-2-weeks bill can come up two or three times in a month. A new bill adds the rest of the current month right away. If the server was off on the 1st, it catches up when it starts.
- In the register, bill rows have a ↻, and rows dated after today are dimmed. The account header shows the balance **Today** next to the balance **After upcoming** bills.
- **Changing a bill** only affects payments that haven't been added yet. Edit a payment that's already in the register there, for example when a utility bill's amount differs. **Deleting** a bill leaves its payments in the register. **Pause** stops it; when you resume it, the months it was paused for are skipped.
- **Bank imports** link a statement row to a bill payment with the same amount within 3 days instead of adding it twice, and mark it cleared. If a bill's amount varies, fix the amount in the register first so the import can match it.
- Choosing a "Transfer: …" payee (a credit card payment, say) makes each payment a transfer between the two accounts.

## Budgeting

The budget is a plan for one month at a time. Each month stands on its own:

- **To Budget** = this month's income minus what you've budgeted this month.
- **Pay at the end of the month:** click **Use next month** on an income category (on the Budget page or in Settings → Categories) and all of that category's income is budgeted in the month after it arrives. Pay that lands on September 29 or 30 then funds October's budget, and the category shows "From September". Other income categories still count in the month they arrive. Reports still show income in the month it was received.
- **Keeping things out of the budget:** click **Exclude from budget** on a category (on the Budget page or in Settings → Categories) for money that isn't the family's, such as work expenses you'll be reimbursed for. Put both the expenses and the reimbursements in that category. Its transactions still show on the Budget page, marked "Not in budget", but they don't count toward income, spending, To Budget or reports, and the category can't be budgeted.
- A category's **balance** = what you budgeted for it this month minus what you spent. Nothing carries over: not unspent money, not overspending, and not income you never budgeted.
- Click a Budgeted amount to edit it. **Enter**, **Tab** and the arrow keys move between categories. **Copy last month** fills in the previous month's amounts.
- Click a Spent amount to see the transactions behind it. Drag categories and groups to reorder them.
- **Usual months:** for spending that only comes up at certain times of year (car registration in March, insurance in January and July), click **Months** on a category and pick them. The category gets a badge listing those months. In a month it's due, the badge is highlighted, with ⚠ if nothing is budgeted for it yet. In other months the row is dimmed unless something was budgeted or spent. This is only a reminder; it doesn't change any amounts.
- Only on-budget accounts count. Transfers between on-budget accounts don't need a category; money moving to an off-budget account (for example, into a brokerage) does.

## Private accounts

Each member can keep accounts the others don't see, such as their own credit card. Tick **Private** when adding the account, or use **Make private** in the account's ⋯ menu (only the member who added a shared account can make it private). A lock marks it in your sidebar.

- Nobody else sees a private account: not in the sidebar, the register, net worth, investments or imports.
- **Counting purchases in the family budget:** in a private on-budget account, tick **Include in family budget** on a transaction when family money paid for it. Included transactions count in the budget and reports like any other, with a **Family** badge in your register, and everyone sees them in full when they look at that category's spending (marked with a lock, without a link to the account). Transactions you don't include stay out of the family budget.
- **Paying the card:** a payment from a family account to your private card is a transfer, so it isn't spending; the purchases you included already count. Others see it in the family account as "Transfer: Private account", and only you can change or delete it (they can still mark it cleared).
- **Share with family** in the ⋯ menu makes the account visible to everyone again.

## Importing

Go to **Settings → Import transactions**, or choose **Import transactions** in an account's menu to import straight into that account. When adding an account, you can also tick **Then import transactions from a file**. At the top of the Import page, pick what you're importing from: a **bank or card statement**, a **529 or fund statement**, or **GnuCash**. Each import can be undone from the Past imports list.

## Importing from GnuCash

On the Import page, choose **GnuCash** and upload a **copy** of your `.gnucash` file as it is. GnuCash's normal (compressed XML) format works, and so does a book saved as sqlite3. Before anything is saved, you can review how each GnuCash account maps:

- Bank, cash, credit card, asset and liability accounts become accounts. You choose whether each one is on budget.
- Income and expense accounts become categories. For example, `Expenses:Auto:Fuel` becomes the group "Auto" and the category "Fuel". Accounts that match an existing category name use that category.
- Equity is treated as opening balances. `Imbalance-*` and `Orphan-*` accounts are skipped, so their share of a transaction is imported as uncategorized.
- Stock and mutual fund accounts become investment holdings in the account their parent GnuCash account is imported into. Buys, sells and splits come in with their share counts, along with the book's price history.

To bring in a single investment account (a 401k, say), export just that account instead: in GnuCash, select it and use File → Export → Export Transactions to CSV, leaving "Use simple layout" unticked, then upload the CSV the same way. When you add an Investment account here, tick **Then import transactions from a file** (or use **Import transactions** in the account's menu). The Import page then opens on GnuCash, and the file's investment account is mapped to it automatically. A CSV has no price history, and funds without a ticker symbol (common in 401k plans) don't get automatic daily prices; add prices for them on the Investments page.

The preview shows how many transactions will be imported and compares each account's balance with GnuCash's. You can import the same book again later: only transactions you haven't imported yet are added, and your previous mapping is remembered. A transaction you deleted here is not brought back. Each import can be undone from the same page.

## Importing bank statements

On the Import page, choose **Bank or card statement**, pick an account and upload an **OFX/QFX** or **CSV** file from your bank:

- For a CSV, confirm which columns hold the date, payee and amount. The app guesses these, including separate debit and credit columns and the date format. Tick the box if spending shows as positive numbers, as is common for credit cards.
- Rows already imported from an earlier statement are skipped, so overlapping files are fine.
- If a row matches a transaction already in the account (same amount, within 3 days), the two are linked instead of duplicated. The existing transaction is marked cleared. This covers rows you entered by hand and rows brought in from GnuCash.
- New rows are cleared, and their category is suggested from the last time you used that payee. You can untick rows or change categories before importing.
- Each import can be undone from the Past imports list. Undo removes the transactions it added and puts the ones it matched back the way they were.

## Importing 529 plan statements

For a 529 plan (or another fund company whose CSV download lists your funds and then your transaction history), add an **Investment** account for it, then on the Import page use **529 or fund statement**: choose the account and upload the CSV.

- Each fund becomes a security, matched by name. Funds without a ticker get a symbol made from their name (e.g. `LARGE-CAP-STOCK-INDEX`) and use the prices from your statements rather than automatic daily prices.
- A contribution is recorded as a cash deposit in the account that then buys shares, so the account's cash stays at zero. Withdrawals and fees sell shares and take the cash out; reinvested earnings and exchanges between funds move shares only. Rows of any other type are listed and skipped.
- The first import adds **opening shares** for each fund, dated the day before the file's first transaction, so the account matches the statement's share counts. They have no cost basis, so cost and gain show as Unknown for those funds.
- Importing a later statement only adds transactions you haven't imported yet. If the share counts still don't match the statement afterwards, the preview says so.

## Investments

Investments live in **Investment** accounts. An account's register holds its cash, and the **Investments** page tracks the securities it holds:

- Add a security by ticker. "Look up" fills in its name and type from Yahoo Finance. Then record buys, sells, dividends, reinvested dividends, splits, and shares moved in or out.
- Buys, sells and dividends add a linked cash entry to the account's register. You can only change that entry from the Investments page.
- Holdings show shares, the latest price, market value, average-cost basis and unrealized gain. Account balances and the sidebar total include market value.
- Each investment account's own page opens on its holdings and their transactions. Click a holding to see just its buys and sells, and use **Add transaction** to record one for that account. Switch to **Cash register** for the account's cash.
- Prices are fetched daily from Yahoo Finance's public chart data, which needs no API key, and you can refresh them on demand. For anything Yahoo doesn't cover, enter prices by hand.

## Reports, live updates and backups

- **Reports**
  - **Net worth:** every account over time, with investments at market value. To leave an account out (say, a child's 529 plan), use **Leave out of net worth** in its ⋯ menu.
  - **Cash flow:** income and spending per month, by category. Opening balances aren't counted as income.
  - **Spending by category:** totals for any period.
  - Transfers between your accounts aren't counted in either, even with a category. So for a mortgage payment split into principal (a transfer to the loan) and interest, only the interest is spending. The budget still counts the whole payment.
- **Live updates:** when one of you changes something, the other's open window refreshes on its own.
- **Backups:** each night the server saves a copy of the database to `backups/` in the data folder and keeps the newest 14. The household owner can also download a fresh copy from **Settings → Backups**. To restore, stop the app, delete `finance.db-wal` and `finance.db-shm` if they exist, and replace `finance.db` with the backup file.

## On your phone

On a phone the app switches to a phone layout. Tabs along the bottom lead to **Budget**, **Accounts**, **Reports**, **Investments** and **More** (settings, imports, payees and sign out). An account's register lists one transaction per row: tap a row to edit it, or tap **+** to add one. On the Budget page, tap a category or group name for its actions, such as Add transaction, Months or Rename.

### Install it as an app

The app can be installed to your home screen and opens full screen like a native app. Installing needs HTTPS, so open it at your Cloudflare Tunnel hostname (see [Remote access with Cloudflare Tunnel](#remote-access-with-cloudflare-tunnel)), not the plain `http://` LAN address.

- **Android (Chrome):** open the site, sign in, then use the menu → **Install app** (or **Add to Home screen**).
- **iPhone (Safari):** open the site, tap **Share** → **Add to Home Screen**. An installed iPhone app keeps its own sign-in, so you sign in once more inside it.

The installed app always loads your data from the server; nothing financial is stored on the phone. Without a connection it shows "Can't reach the server" until you're back online. After an update, the app picks up the new version the next time it's opened.

If you use Cloudflare Access and the install option doesn't appear, add an Access **Bypass** policy for the paths `/manifest.webmanifest` and `/icons/*`. They contain only the app's name and icons, and some browsers fetch them without your Access sign-in.

## Production (Docker)

`docker/docker-compose.yml` runs the app behind a [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/), so you can reach it from anywhere without opening ports on your router. Setup is described under [Remote access with Cloudflare Tunnel](#remote-access-with-cloudflare-tunnel).

```sh
cd docker
docker compose up -d --build
```

The app's SQLite database is stored in `docker/data/`, and nightly backups go to `docker/data/backups/`. The container makes sure the app's user (uid 1000) owns that folder on start-up, then runs the app as that user, not as root. Copy that folder somewhere else (another disk, or cloud storage) to keep your data safe if this machine fails.

### Configuration

All settings are optional. To change any of them, copy `.env.example` to `.env` at the repo root; it lists every option and explains each one. Both the dev scripts and `docker compose` read that file. The Docker setup always uses `PORT=8080`, `DATA_DIR=/data`, `COOKIE_SECURE=true` and `TRUST_PROXY=false`, whatever `.env` says.

| Variable                  | Default (dev / Docker)       | Purpose                                              |
| ------------------------- | ---------------------------- | ---------------------------------------------------- |
| `PORT`                    | `3000` / `8080`              | HTTP port                                            |
| `DATA_DIR`                | `./data` / `/data`           | Folder that holds `finance.db`                       |
| `WEB_DIST`                | `apps/web/dist`              | Built web app served by the server                   |
| `COOKIE_SECURE`           | `false`                      | Set to `true` when the app is served over HTTPS      |
| `TRUST_PROXY`             | `false`                      | `true` behind your own reverse proxy (see below)     |
| `TZ`                      | system / `UTC`               | Your time zone, e.g. `America/Chicago`               |
| `PRICE_REFRESH`           | `on`                         | Set to `off` to stop fetching investment prices      |
| `BACKUP_KEEP`             | `14`                         | Nightly backups to keep; `0` turns them off          |
| `SEED_HOUSEHOLD_NAME`     | (unset)                      | First-boot seeding; see below                        |
| `SEED_OWNER_USERNAME`     | (unset)                      |                                                      |
| `SEED_OWNER_PASSWORD`     | (unset)                      |                                                      |
| `SEED_OWNER_DISPLAY_NAME` | the username                 |                                                      |

**Seeding the owner on first start.** If the database is empty, the server creates the household and the owner account from the `SEED_*` variables, so the setup page never appears. The household name, username and password must all be set; if only some are set, or a value is invalid, the server won't start. Seeding is skipped once any user exists, so you can remove `SEED_OWNER_PASSWORD` after the first start.

There are no signing secrets to configure, `JWT_SECRET` included. Sessions use random tokens that the server checks against hashes stored in the database.

**Set `TZ` when using Docker.** Containers run in UTC, so without it "today" (default dates, backup names, report ranges) changes over at UTC midnight rather than yours.

## Security

- Passwords are hashed with Argon2. Sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie, and only their hashes are stored. They last 30 days and renew while in use.
- Every change must be sent as JSON (or as a raw file upload), which browsers can't do from another site without permission. This blocks cross-site request forgery.
- Responses carry a strict Content-Security-Policy, block framing, and turn off content sniffing and referrers.
- Failed sign-ins are limited per visitor: 10 for one username, or 30 across usernames, within 15 minutes. Someone guessing at your username can't lock you out from your own devices. Behind a reverse proxy, set `TRUST_PROXY=true` so the limit uses each visitor's address rather than the proxy's.
- Pending sign-in attempts count toward those limits. Password work (sign-in, setup, invite acceptance, password changes and owner resets) also has a shared limit of 4 concurrent requests and 60 starts per minute per server process; excess requests receive HTTP 429. Closed setup and unavailable invites are rejected before hashing passwords.
- Changing a password, an owner reset and removing a member all end the affected sessions straight away.
- Everyone in the household sees and can change everything except other members' private accounts. Only the owner can create invite links and download backups.

**To reach the app from outside your home network,** use the Docker setup's Cloudflare Tunnel (below), or put it behind a reverse proxy that handles HTTPS, such as Caddy or Traefik, and set `COOKIE_SECURE=true`. Finish first-run setup (or use the `SEED_*` variables) before exposing it: until an owner exists, anyone who can reach the app can create one.

### Remote access with Cloudflare Tunnel

The compose file starts two containers: the app, and Cloudflare's connector (`cloudflared`), which starts once the app is healthy. The app's port is published only on the server itself (http://localhost:8082), secure cookies are on, and forwarded headers are ignored. Use the HTTPS hostname from every other device, even at home.

1. **Create the owner first.** Either set all the required `SEED_*` settings in the root `.env`, or start just the app with `docker compose up -d --build finance` and finish setup at http://localhost:8082 in a browser on the server (or through an SSH port forward). Use a long, unique owner password.
2. In Cloudflare, create a remotely managed tunnel and a published application route for your hostname (for example `finance.example.com`). Set the service type to **HTTP** and its URL to **`finance:8080`** (`http://finance:8080` as a full URL). Here `finance` is the Docker service name; `localhost` would refer to the connector container.
3. Create a Cloudflare Access self-hosted application for that exact hostname, with an Allow policy restricted to your household's email addresses or identity provider. Complete this before starting the tunnel. Keep the app's own household login as well.
4. From the `docker/` directory, create `secrets/` and save **only the tunnel token** into `secrets/cloudflare-tunnel-token`. This file is ignored by Git and excluded from Docker builds. Docker Compose mounts it as a secret into the connector only. Ensure the container can read the file; keep the containing directory accessible only to your server administrator. Never paste the token into a committed file.
5. Start everything from the `docker/` directory and check the connector:

   ```sh
   docker compose up -d --build
   docker compose logs --tail=50 cloudflared
   ```

6. Open the HTTPS hostname from your phone with Wi-Fi disabled. Check the Access challenge, household login, a report, a small import, and live updates from a second browser. Do not forward router ports. Configure Cloudflare cache rules to bypass caching for this hostname; API responses also send `Cache-Control: no-store`.

The connector token uses Cloudflare's [`--token-file` option](https://developers.cloudflare.com/tunnel/reference/run-parameters/). The connector image follows `latest`; update it deliberately with `docker compose pull cloudflared` followed by `docker compose up -d` (or pin a tested tag for controlled updates).

All visitors through the tunnel share the visitor rate limit, since forwarded addresses are not trusted. For a small household this is conservative, but repeated failed logins from one visitor can temporarily throttle others.

Cloudflare's upload limit depends on your plan and can be smaller than this app's 200 MiB limit. For a large GnuCash import, use http://localhost:8082 on the server (or an SSH port forward) instead of the tunnel. If Cloudflare Access expires while a page is open, refresh and authenticate again.

To turn off remote access, run `docker compose stop cloudflared`; the app keeps running at http://localhost:8082 on the server. Remove the published route in Cloudflare if it is no longer needed.

### Import resource limits

Import previews expire after one hour and are released after a successful import. The server permits three open previews per user, eight overall, and two simultaneous uploads (one per user). Retained preview data is limited to an estimated 128 MiB per file and 256 MiB overall. CSV imports have a 100,000-row and 1,000,000-cell ceiling; OFX and GnuCash parsing also bound records, and GnuCash XML is limited to 128 MiB after decompression. Complex records may reach the preview memory limit sooner. Split oversized files into smaller imports; finish existing previews or wait for them to expire if the server reports that preview storage is full.

## Known limitations

- **Backups include private accounts.** A backup is a copy of the whole database, so the owner who downloads one can read every member's private accounts with a database tool. A removed member's private accounts stay hidden from everyone.
- **One currency per household.** It's a display setting; amounts aren't converted. Accounts in other currencies import from GnuCash at their converted value, and securities priced in another currency aren't converted.
- **No email.** Password resets go through the owner, or the command above for the owner.

## Contributing

`main` is protected, so all changes go through pull requests.
