# RB-BACKUP: backups and the restore drill (SEC-13, SEC-27)

## What runs

The `backup` service takes an encrypted backup every 15 minutes into the `backups` volume (or `WDB_BACKUP_DIR`):
`wdb-<UTC>-<headSeq>.backup`. It holds the log, the audit log, staff, devices and exports; sessions are left out,
so after a restore everyone signs in again. Retention: the newest 96, plus one a day for 30 days and one a month
for 12 months. A backup counts as done (`BACKUP_DONE` in the audit log) only once its file is written.

## Off-host copy (every 15 minutes)

A backup on the ward server's own disk does not survive that disk, or ransomware on the host. Copy the backups to
the backup target from a host timer, as the ward server's admin user (it needs Docker and SSH keys to the target):

```bash
deploy/copy-backups.sh wdb-backup@<BACKUP_TARGET>:/srv/wdb-backups
```

It copies the files the backup service keeps now into `/var/lib/wdb/backup-stage` (`WDB_BACKUP_STAGE`), then
rsyncs new ones to the target and never deletes there; the target keeps its own retention. It exits non-zero on
any failure. Run it from a systemd timer (`OnCalendar=*:0/15`) and watch the unit for failures; nothing alerts on
a stale off-host copy yet. RB-NET allows SSH out to `BACKUP_TARGET` only.

The key is the `backup_key` secret. **Escrow it offline with the CA root**: without it no backup can be read.
A stale backup raises `BACKUP_STALE` (over an hour since the last one); see `alerts.md`.

## Restore drill (monthly, and before go-live)

1. Make an empty database: `docker compose exec postgres psql -U wdb_owner -d wdb -c "CREATE DATABASE wdb_drill"`.
2. Pick the newest file: `docker compose run --rm --no-deps --entrypoint sh backup -c 'ls -t /backups | head -1'`.
3. Restore and time it: `time WDB_RESTORE_DB=wdb_drill docker compose run --rm --no-deps restore /backups/<file>`.
   It runs the migrations, loads the rows, and ends with verify-chain; it prints the head seq and hash.
4. Compare with the live server: `docker compose run --rm --no-deps migrate node src/verify-chain.ts`. The head hash
   must equal the restored one if nothing was pushed since the backup, or be an extension of it otherwise
   (compare with a recovery export or a tablet's head).
5. Record the time and the hashes below, then `DROP DATABASE wdb_drill`.

| Date | Events | Restore time | Head hash matched |
|---|---|---|---|
| 2026-11-12 (dev machine, demo stack) | 100,300 | 8.1 s (13 s with container start) | yes |

## Real restore (server lost or encrypted)

Follow design.md §11.4. In short:

1. Rebuild the host, restore the secrets from escrow, and copy the newest clean backup from the backup target into
   the `backups` volume (or `WDB_BACKUP_DIR`).
2. Start the database alone: `docker compose up -d postgres`. The server must not run yet.
3. Restore into the empty `wdb` database with step 3 above, without `WDB_RESTORE_DB`. It ends with verify-chain and
   marks the server as recovering.
4. Start the stack: `docker compose up -d`. The server holds every tablet's pushes (`RECOVERING`), so a tablet
   that was behind cannot take the place of entries the backup lacks. Everyone signs in again (sessions are not
   backed up).
5. On the admin tablet that synced most recently: Recovery → Replay log to the ward server. Check any other tablet
   that may have been ahead the same way.
   Imports of saved tablet files wait until after step 6.
6. Recovery → Finish recovery. The server refuses (`REPLAY_FIRST`) while a tablet it has heard from holds more of
   the log. Tablets then send their saved changes; the `RECOVERING` alert clears.
7. My changes on each tablet: a change refused `STAFF_NOT_ON_DEVICE` was made by someone whose first sign-in on
   that tablet came after the backup. Have them sign in on that tablet, then import the tablet's saved file.
