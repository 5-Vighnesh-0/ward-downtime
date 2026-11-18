# Alerts (SEC-20, design.md §13.3)

Alerts show as red banners on charge and admin tablets and in Admin → Ward server health, and are logged at
`error` (`"event":"alert"`). None of them stops the ward working. Three lines each: what, check, act.

**AUTH_FAILURES**: ≥ 10 failed sign-ins for one staff ID or one tablet in 5 minutes.
Check the Audit screen, filter `SIGNIN_FAIL`. A forgotten PIN: reset it in Admin → Staff.
Unknown staff IDs or a tablet nobody is using: revoke the tablet in Admin → Devices and tell IT security.

**SIGNATURE_FAILURE**: a change arrived with a signature that does not match its tablet's key.
Filter the audit log for `EVENT_REFUSED` and find the tablet. Normal tablets never cause this.
Revoke that tablet and treat it as tampered with; re-enroll it only after IT has checked it.

**EVENT_FLOOD**: one tablet sent over 300 changes in a minute.
Look at that tablet's recent changes in the audit log; a stuck app or a script both look like this.
If the changes are not real ward work, revoke the tablet.

**CLOCK_SKEW**: a tablet's clock is more than 2 minutes off. Ordering is not affected; displayed times are.
Fix the tablet's date and time (MDM: automatic time). The banner on that tablet clears on its next request.

**DEVICE_LAGGING**: an approved tablet has not contacted the server for over an hour.
Find the tablet. If it was offline with unsent changes, sync it or use My changes → Save to file.
If it is lost, revoke it.

**CHAIN_BREAK**: the hourly (and boot) verify-chain found a log entry that does not match its hash.
Do not restore or edit anything yet. Run `docker compose run --rm --no-deps migrate node src/verify-chain.ts`.
If it still fails, treat the server as tampered with: follow the ransomware steps (design.md §11.4, RB-BACKUP).

**BACKUP_STALE**: no backup has been written for over an hour (or none since the server started an hour ago).
Check `docker compose logs backup` for `backup_failed` (disk full, or a backup folder it cannot write).
Fix it and watch for the next `backup_done`; until then the tablets' copies are the only recent copy.

**RECOVERING**: the server was restored from a backup and holds every tablet's new changes.
Follow RB-BACKUP, Real restore: replay the log from the most recently synced tablet, then Recovery → Finish recovery.
Tablets keep their changes meanwhile; nothing is lost while the alert shows.
