#!/bin/sh
# Back up the database, then rebuild the app from this checkout and label it with the current
# Git version. Set SKIP_BACKUP=1 to update without the backup.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

container=family-finance

GIT_COMMIT=$(git rev-parse --short HEAD)
export GIT_COMMIT

if [ "${SKIP_BACKUP:-}" = "1" ]; then
  echo "Skipping the pre-update backup (SKIP_BACKUP=1)."
elif [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]; then
  # Name the copy after the version it came from: that's the version to go back to with it.
  old=$(docker exec "$container" printenv GIT_COMMIT 2>/dev/null || echo unknown)
  label="before-update-from-$old"
  echo "Backing up the database (version $old)…"
  if docker exec "$container" grep -q '"backup"' apps/server/src/cli.ts; then
    docker exec -u bun "$container" bun apps/server/src/cli.ts backup "$label"
  else
    # Versions from before the backup command: make the same copy directly.
    docker exec -u bun -e LABEL="$label" "$container" bun -e '
      import { Database } from "bun:sqlite";
      const d = new Date(), p = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const name = `finance-${stamp}-${process.env.LABEL}.db`;
      const path = `${process.env.DATA_DIR}/backups/${name}`;
      require("node:fs").mkdirSync(`${process.env.DATA_DIR}/backups`, { recursive: true });
      const db = new Database(`${process.env.DATA_DIR}/finance.db`, { readwrite: true });
      db.exec("PRAGMA busy_timeout = 5000;");
      db.run("VACUUM INTO ?", [path]);
      console.log(`Backed up the database to ${path}`);
    '
  fi
elif [ -e data/finance.db ]; then
  echo "The app isn't running, so the database can't be backed up before updating." >&2
  echo "Start it first (docker compose up -d finance), or run with SKIP_BACKUP=1." >&2
  exit 1
fi

printf 'Building Family Finance version %s…\n' "$GIT_COMMIT"
exec docker compose up -d --build finance
