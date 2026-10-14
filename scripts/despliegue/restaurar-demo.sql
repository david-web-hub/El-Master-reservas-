-- =========================================================
-- VOLVER A LA DEMOSTRACIÓN (solo si hace falta y con autorización)
--
-- Deshace ARCHIVAR_DEMO: devuelve las tablas de la demostración desde el
-- esquema respaldo_demo a public. Las tablas que creó la versión nueva con
-- esos mismos nombres NO se borran: se apartan al esquema respaldo_nueva.
-- No toca ninguna otra tabla (cuentas, agenda nueva, Panel Maestro).
--
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/despliegue/restaurar-demo.sql
-- Después: volver a desplegar la versión anterior en Render.
-- =========================================================
BEGIN;

DO $$
DECLARE
  t TEXT;
BEGIN
  IF to_regnamespace('respaldo_demo') IS NULL THEN
    RAISE EXCEPTION 'No existe el esquema respaldo_demo: no hay nada que restaurar.';
  END IF;
  CREATE SCHEMA IF NOT EXISTS respaldo_nueva;
  FOREACH t IN ARRAY ARRAY['sales', 'cash_sessions', 'products', 'admin_settings', 'media_assets'] LOOP
    IF to_regclass('respaldo_demo.' || t) IS NULL THEN
      CONTINUE;
    END IF;
    IF to_regclass('respaldo_nueva.' || t) IS NOT NULL THEN
      RAISE EXCEPTION 'respaldo_nueva.% ya existe; revisa antes de continuar.', t;
    END IF;
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA respaldo_nueva', t);
    END IF;
    EXECUTE format('ALTER TABLE respaldo_demo.%I SET SCHEMA public', t);
  END LOOP;
END $$;

COMMIT;
