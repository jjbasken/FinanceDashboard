# Project review

Reviewed October 7, 2026. Scope: source review of authentication, deployment, imports, ledger access controls, backup behavior and shared UI components, plus the automated suite, type checking and production build. This is not a penetration test or a browser usability study.

## Addressed during this review

- **P1 — Secrets entered the Docker build context.** The build stage uses `COPY . .`, and `.dockerignore` did not exclude `.env` files. Root startup credentials could be retained in build layers/cache (the final runtime stage does not directly copy the root `.env`). Added exclusions for environment files and the new connector secret directory. If builds previously used a populated `.env`, remove affected build caches and rotate any credentials whose build artifacts were shared.
- **P2 — Password changes and owner resets bypassed password-work limits.** These authenticated routes invoked expensive password verification/hashing directly. A logged-in user could exhaust server resources with parallel requests. Both now use the existing shared limiter; regression coverage verifies rejection happens before password work.
- **P2 — API responses lacked a uniform cache prohibition.** Financial and authentication responses now carry `Cache-Control: no-store`, including API errors. This reduces exposure through browser/proxy caching when remote access is enabled. Deliberate Cloudflare caching rules should still bypass the hostname.

## Follow-up fixes

The four requested findings have been addressed:

- **Import memory:** each app instance now owns bounded preview storage shared across the three formats. It permits at most three retained previews per user and eight per server, two uploads at once and one per user. Retained data has conservative object-memory budgets of 128 MiB per preview and 256 MiB total. Upload bodies are limited while streaming even without a Content-Length header. Preview expiry releases memory after an hour; successful commits release it immediately. CSV rows/cells, OFX records, SQLite table rows, XML decompression and XML tree complexity also have explicit limits. Oversized imports return an explanation; split them into smaller files.
- **Backup status:** scheduler-enabled state is separate from the backup directory. Disabling nightly backups accurately updates Settings while preserving access to old copies and manual downloads.
- **Large CSV imports:** column-width validation uses a reduction rather than spreading rows into function arguments. A regression check covers one million rows; parser limits separately reject overly large datasets with useful errors.
- **Dialog accessibility:** every shared dialog references its heading with a unique `aria-labelledby` value. Browser accessibility inspection confirms the investment editor's name.

The investment transaction editor also uses the wider dialog, permits form columns and long selects to shrink, and stacks fields at phone width. Browser checks using long account and security names found no horizontal overflow in the saved-transaction editor at normal width or at a 390-pixel viewport.

**Deferred at the user's request:** the five-character password minimum in `packages/shared/src/auth.ts` remains unchanged. Use a long unique owner password and Cloudflare Access for remote deployment.

## Remote access added

`docker/docker-compose.tunnel.yml` is a standalone alternative deployment using the existing database directory. It starts the official Cloudflare connector after the finance service is healthy, mounts its token as a secret, enables secure session cookies, and publishes the local port only on loopback. Forwarded headers stay untrusted, so tunnel visitors share the existing visitor rate limit. The README explains hostname routing to `http://finance:8080`, Cloudflare Access allow policies, setup order, token handling, remote verification, updates and returning to LAN access.

The configuration is prepared, but no Cloudflare account, domain, policy or token was configured. Docker is unavailable in the review environment, so Compose runtime validation and an actual remote connection still need to be checked on the home server. Cloudflare's plan-dependent upload limits can also be below the app's own upload limit.

## Validation

The baseline review suite passed 203 tests; the initial security changes passed 205. All 215 tests pass after the follow-up fixes, which add coverage for upload concurrency, quotas, memory accounting, expiry, bounded streaming, parser limits, large CSV widths, app isolation and disabled backup status. Type checking and the production web build pass. The build still reports a large main JavaScript chunk (about 690 kB before compression). The investment editor was checked in a browser with temporary sample data; a full screen-reader usability study and live Cloudflare tunnel verification remain outside this validation.
