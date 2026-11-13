#!/bin/sh
# Creates the stack's secrets once (design.md §11.1). Never commit them; in production keep them under
# /etc/wdb/secrets (mode 0400) and set WDB_SECRETS_DIR. Existing files are never overwritten.
set -eu
dir="${WDB_SECRETS_DIR:-$(dirname "$0")/secrets}"
mkdir -p "$dir"
chmod 700 "$dir"
for name in db_owner_password db_app_password step_ca_password backup_key; do
  [ -e "$dir/$name" ] && continue
  (umask 077 && openssl rand -base64 32 | tr -d '\n' > "$dir/$name")
  echo "created $dir/$name"
done
