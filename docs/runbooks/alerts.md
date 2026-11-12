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
