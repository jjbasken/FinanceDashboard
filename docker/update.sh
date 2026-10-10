#!/bin/sh
# Rebuild the app from this checkout and label it with the current Git version.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$script_dir"

GIT_COMMIT=$(git rev-parse --short HEAD)
export GIT_COMMIT

printf 'Building Family Finance version %s…\n' "$GIT_COMMIT"
exec docker compose up -d --build finance
