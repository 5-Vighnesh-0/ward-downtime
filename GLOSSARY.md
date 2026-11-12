# Glossary

| Term | Meaning |
|---|---|
| Ward server | The one machine on the ward LAN that orders events and stores the log |
| Device | A tablet or PC running the PWA; keeps a full local copy and a queue |
| Event | An immutable record of one change (admit, discharge, transfer, rename, resolve) |
| Event log | Append-only list of events; the board is a replay of it |
| Replay | Applying events in server order to rebuild the board; always deterministic |
| server_seq | Number the server gives each event; defines the global order |
| basedOn | The last server_seq a device had seen when it made the event |
| Idempotent | Sending the same event twice has the same effect as once |
| Pending | Made on a device, not yet confirmed by the server |
| Conflict | Two admits to one bed; both held until a charge nurse resolves it |
| Resolve | Charge nurse keeps one admit; recorded as its own event |
| Rejected | An event that lost a conflict; stays in the log, marked rejected |
| Temporary ID | Placeholder patient ID (device prefix + counter) used during downtime |
| Recovery export | File of applied events with original times, for matching to the EHR later |
| Downtime | Period when the EHR or network is unavailable |
| EHR | Electronic health record system |
| ADT | Admit / Discharge / Transfer messages used by hospital systems |
| Charge nurse | Nurse in charge of the ward; resolves conflicts |
| Hash chain | Each log entry includes the previous entry's hash, so tampering shows |
| HLC | Hybrid logical clock; used for display and audit only, never for ordering |
| PWA | Progressive web app: installable, works offline via a service worker |
| Local CA | Certificate authority run inside the hospital so HTTPS works on the LAN |
| Synthetic data | Made-up patient data; the only data allowed in this project |
