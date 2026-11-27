-- The app reads and writes the one branding row; it never deletes it (spec 2026-11-18 §1.4).
GRANT SELECT, INSERT, UPDATE ON ward_settings TO wdb_app;
