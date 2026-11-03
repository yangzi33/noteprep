-- Display time zone preference (IANA name). NULL means "Auto": the browser-detected zone is used. Display only;
-- stored timestamps stay in UTC. Grants and RLS already cover profile. The application validates the name against
-- the zones the picker offers; the CHECK only bounds the size.
ALTER TABLE "profile" ADD COLUMN "timezone" TEXT;
ALTER TABLE "profile" ADD CONSTRAINT "profile_timezone_length" CHECK (timezone IS NULL OR char_length(timezone) BETWEEN 1 AND 64);
