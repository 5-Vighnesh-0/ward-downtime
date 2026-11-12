-- Append-only enforcement (SEC-10, SEC-18) and the genesis head of the hash chain.
-- Migrations run as the owner; the app connects as wdb_app, whose login and password are set at deploy time.
DO $$ BEGIN
  CREATE ROLE wdb_app NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO wdb_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON events, audit_log TO wdb_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_log_audit_id_seq TO wdb_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON log_head TO wdb_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON devices, staff, sessions TO wdb_app;
--> statement-breakpoint
CREATE FUNCTION wdb_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
--> statement-breakpoint
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION wdb_append_only();
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION wdb_append_only();
--> statement-breakpoint
INSERT INTO log_head (id, last_seq, last_hash) VALUES (1, 0, decode(repeat('00', 32), 'hex'));
