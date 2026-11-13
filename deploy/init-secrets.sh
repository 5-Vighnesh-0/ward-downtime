#!/bin/sh
# Creates the stack's secrets once (design.md §11.1). Never commit them; in production keep them under
# /etc/wdb/secrets and set WDB_SECRETS_DIR. Existing files are never overwritten.
# Compose bind-mounts each file with its host owner and mode, and the containers run as their own non-root users
# (step-ca and server as uid 1000), so the files are 0644 and the directory (0700) keeps other host users out.
set -eu
dir="${WDB_SECRETS_DIR:-$(dirname "$0")/secrets}"
mkdir -p "$dir"
chmod 700 "$dir"
for name in db_owner_password db_app_password step_ca_password backup_key; do
  [ -e "$dir/$name" ] && continue
  (umask 077 && openssl rand -base64 32 | tr -d '\n' > "$dir/$name")
  chmod 644 "$dir/$name"
  echo "created $dir/$name"
done
