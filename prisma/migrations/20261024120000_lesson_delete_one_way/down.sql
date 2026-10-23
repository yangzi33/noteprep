-- ROLLBACK for 20261024120000_lesson_delete_one_way. NOT run by Prisma (it only reads migration.sql); an operator runs it by hand
-- with the migration role, in one transaction, then deletes the row of this migration from "_prisma_migrations":
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f prisma/migrations/20261024120000_lesson_delete_one_way/down.sql
--   DELETE FROM _prisma_migrations WHERE migration_name = '20261024120000_lesson_delete_one_way';
-- Safe at any time: it only removes the guard. Do NOT un-delete lessons that have retired exports (the drift view would report them).

DROP TRIGGER "lesson_deleted_final" ON "lesson";
DROP FUNCTION lesson_deleted_is_final();
