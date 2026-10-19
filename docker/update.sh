#!/bin/sh
# Fetch the new app image, back up the database, then restart the app on the new image.
# By default the image is pulled from GitHub Container Registry (FINANCE_TAG picks the version,
# default latest). Set BUILD=1 to build this checkout instead, labelled with its Git version.
# Set SKIP_BACKUP=1 to update without the backup.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

container=family-finance

# Get the new image ready first, so the app keeps running (and the backup is as recent as
# possible) while it downloads or builds.
if [ "${BUILD:-}" = "1" ]; then
  GIT_COMMIT=$(git rev-parse --short HEAD)
  export GIT_COMMIT
  printf 'Building Family Finance version %s…\n' "$GIT_COMMIT"
  docker compose build finance
else
  image=$(docker compose config --images finance)
  printf 'Pulling %s…\n' "$image"
  docker compose pull finance
  new_id=$(docker image inspect -f '{{.Id}}' "$image")
  running_id=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
  new=$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
    sed -n 's/^GIT_COMMIT=//p')
  if [ "$new_id" = "$running_id" ] &&
    [ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" = "true" ]; then
    echo "Already running version ${new:-unknown}; nothing to update."
    exit 0
  fi
  echo "Pulled version ${new:-unknown}."
fi

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
      const fs = require("node:fs");
      fs.closeSync(fs.openSync(path, "wx"));
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        db.run("VACUUM INTO ?", [path]);
      } catch (err) {
        fs.unlinkSync(path);
        throw err;
      } finally {
        db.close();
      }
      console.log(`Backed up the database to ${path}`);
    '
  fi
elif [ -e data/finance.db ]; then
  echo "The app isn't running, so the database can't be backed up before updating." >&2
  echo "Start it first (docker compose up -d finance), or run with SKIP_BACKUP=1." >&2
  exit 1
fi

echo "Restarting Family Finance on the new image…"
exec docker compose up -d --no-build finance
