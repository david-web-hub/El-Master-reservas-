-- =========================================================
-- REVERTIR CLAVES DE LA FASE 2 (solo si hace falta volver a una versión anterior)
--
-- Restaura las claves únicas originales:
--   admin_settings (section), media_assets (id), cash_sessions (session_date)
-- No borra filas ni columnas (business_id se queda: la versión anterior la ignora).
-- Se niega a ejecutarse si ya hay datos de más de una barbería, porque las
-- claves antiguas no permiten repetir sección, imagen o fecha entre barberías.
--
-- Uso (solo con autorización): psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migracion/revertir-claves-fase2.sql
-- =========================================================
BEGIN;

DO $$
BEGIN
  IF (SELECT count(DISTINCT business_id) FROM admin_settings) > 1
     OR (SELECT count(DISTINCT business_id) FROM media_assets) > 1
     OR (SELECT count(DISTINCT business_id) FROM cash_sessions) > 1 THEN
    RAISE EXCEPTION 'Hay datos de varias barberías; no se pueden restaurar las claves antiguas sin perder información.';
  END IF;
END $$;

ALTER TABLE admin_settings DROP CONSTRAINT admin_settings_pkey,
  ADD CONSTRAINT admin_settings_pkey PRIMARY KEY (section);

ALTER TABLE media_assets DROP CONSTRAINT media_assets_pkey,
  ADD CONSTRAINT media_assets_pkey PRIMARY KEY (id);

ALTER TABLE cash_sessions ADD CONSTRAINT cash_sessions_session_date_key UNIQUE (session_date);

COMMIT;
