#!/bin/sh
# Copies the encrypted backups off the ward server (SEC-27, docs/runbooks/RB-BACKUP.md): a backup on the same disk
# does not survive the disk, or ransomware on the host. Run it from a host timer every 15 minutes.
# Usage: deploy/copy-backups.sh <rsync target, e.g. wdb-backup@<BACKUP_TARGET>:/srv/wdb-backups>
# Exits non-zero on any failure, so the timer shows it failed; it never deletes anything on the target.
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <rsync target>" >&2; exit 2; }
cd "$(dirname "$0")/.."
stage="${WDB_BACKUP_STAGE:-/var/lib/wdb/backup-stage}"
mkdir -p "$stage"
chmod 700 "$stage"
# A fresh copy of what the backup service keeps now (its retention decides what that is).
find "$stage" -maxdepth 1 -name 'wdb-*.backup' -delete
docker compose cp backup:/backups/. "$stage/" >/dev/null
find "$stage" -maxdepth 1 -name '*.part' -delete # a backup being written right now
n=$(find "$stage" -maxdepth 1 -name 'wdb-*.backup' | wc -l)
[ "$n" -gt 0 ] || { echo "no backups to copy" >&2; exit 1; }
rsync -a --ignore-existing "$stage"/wdb-*.backup "$1/"
echo "copied $n backup files to $1"
