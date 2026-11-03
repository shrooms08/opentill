#!/bin/sh
# OpenTill container entrypoint — volume-safe privilege handling.
#
# Platform volumes (Railway in particular) are mounted root-owned, so the
# unprivileged `node` user cannot create the SQLite file or the Tachi key
# index on them.
#
#   started as root  -> create + chown the data directories, then drop to
#                       `node` with gosu and exec the server (PID 1 stays the
#                       server, so signals reach it).
#   started non-root -> verify the data directories are writable and exec;
#                       if they are not, fail fast with the fix.
#
# On Railway the image's `USER node` is overridden by RAILWAY_RUN_UID=0, which
# is what lets this script start as root. Docker / docker-compose / Fly start
# as `node` and keep working unchanged.
set -eu

# Absolute parent directories of every path the gateway writes.
data_dirs() {
  for p in "${OPENTILL_DB_PATH:-/data/opentill.db}" "${TACHI_STATE_PATH:-}"; do
    case "$p" in
      /*) dirname "$p" ;;
    esac
  done | sort -u
}

if [ "$(id -u)" = "0" ]; then
  data_dirs | while IFS= read -r dir; do
    mkdir -p "$dir"
    chown -R node:node "$dir"
  done
  exec gosu node "$@"
fi

data_dirs | while IFS= read -r dir; do
  if ! { mkdir -p "$dir" && [ -w "$dir" ]; } 2>/dev/null; then
    echo "opentill: data directory $dir is not writable by uid $(id -u)." >&2
    echo "opentill: on Railway set the service variable RAILWAY_RUN_UID=0 so this entrypoint" >&2
    echo "opentill: starts as root, fixes the volume's ownership, and drops to the 'node' user." >&2
    exit 1
  fi
done

exec "$@"
