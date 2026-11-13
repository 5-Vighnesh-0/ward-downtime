# RB-BACKUP: backups and the restore drill (SEC-13, SEC-27)

## What runs

The `backup` service takes an encrypted backup every 15 minutes into the `backups` volume (or `WDB_BACKUP_DIR`):
`wdb-<UTC>-<headSeq>.backup`. It holds the log, the audit log, staff, devices and exports; sessions are left out,
so after a restore everyone signs in again. Retention: the newest 96, plus one a day for 30 days and one a month
for 12 months. Copy the folder to the standby or backup host (rsync or the hospital's backup agent; not in Compose).

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

Follow RB-RW (design.md §11.4): rebuild the host, restore the newest clean backup into the empty `wdb` database
with step 3 (no `WDB_RESTORE_DB`), start the stack, then replay the newest entries from a tablet
(Recovery → Replay log to the ward server).
