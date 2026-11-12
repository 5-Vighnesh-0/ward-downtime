-- The app may record exports but never change or remove the record (SEC-15, SEC-18).
GRANT SELECT, INSERT ON exports TO wdb_app;
--> statement-breakpoint
CREATE TRIGGER exports_append_only BEFORE UPDATE OR DELETE ON exports
  FOR EACH ROW EXECUTE FUNCTION wdb_append_only();
