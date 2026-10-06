#!/bin/sh
# Make sure the app can write its data folder, then run it as the unprivileged "bun" user.
#
# Docker creates a missing bind-mount folder (docker/data) owned by root, which the app's user
# can't write to. Starting as root lets us fix the ownership once and then drop privileges.
set -e

if [ "$(id -u)" = "0" ]; then
  DATA="${DATA_DIR:-/data}"
  mkdir -p "$DATA"
  if [ "$(stat -c %u "$DATA")" != "$(id -u bun)" ]; then
    echo "Giving the bun user (uid $(id -u bun)) ownership of $DATA"
    chown -R bun:bun "$DATA" || echo "Warning: couldn't change the owner of $DATA; the app may not be able to write to it."
  fi
  exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
fi

# Started as a specific user (e.g. "user:" in docker-compose): run as that user.
exec "$@"
