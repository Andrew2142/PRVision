#!/bin/sh
# Starts a PRVision process inside the container. Without PRVISION_SECRET_KEY it creates one in the data dir
# on first start and reuses it after, so stored tokens stay readable across restarts.
set -eu

: "${PRVISION_DATA_DIR:?PRVISION_DATA_DIR must be set}"
mkdir -p "$PRVISION_DATA_DIR"

if [ -z "${PRVISION_SECRET_KEY:-}" ]; then
  key_file="$PRVISION_DATA_DIR/secret.key"
  if [ ! -s "$key_file" ]; then
    umask 077
    node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))" > "$key_file"
  fi
  PRVISION_SECRET_KEY="$(cat "$key_file")"
  export PRVISION_SECRET_KEY
fi

exec "$@"
