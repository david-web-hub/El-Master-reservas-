#!/usr/bin/env bash
# Respaldo completo de PostgreSQL (solo lectura sobre la base de origen).
#
# Uso:
#   DATABASE_URL='postgres://...' scripts/respaldo/respaldo-postgres.sh [carpeta]
#
# Genera, en respaldos/pg-<fecha>/ (ignorada por git):
#   base.dump       copia completa en formato personalizado (pg_restore)
#   esquema.sql     solo la estructura, legible
#   contenido.txt   índice del respaldo verificado con pg_restore --list
#   filas.txt       número de filas por tabla en el momento del respaldo
#   SHA256SUMS      sumas de verificación
# Nunca imprime DATABASE_URL. Requiere pg_dump de la misma versión mayor (o
# superior) que el servidor.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "Define DATABASE_URL en el entorno (no la escribas en el repositorio)." >&2
  exit 2
fi
for cmd in pg_dump pg_restore psql sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Falta $cmd" >&2; exit 2; }
done

sello="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
dir="${1:-respaldos/pg-$sello}"
mkdir -p "$dir"
chmod 700 "$dir"

# Render exige SSL desde fuera de su red.
export PGSSLMODE="${PGSSLMODE:-require}"

echo "Versión del servidor:"
psql "$DATABASE_URL" -X -A -t -c 'SHOW server_version' 
echo "Versión local: $(pg_dump --version)"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file "$dir/base.dump"
pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges --file "$dir/esquema.sql"
pg_restore --list "$dir/base.dump" > "$dir/contenido.txt"

psql "$DATABASE_URL" -X -q -A -t -v ON_ERROR_STOP=1 > "$dir/filas.txt" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT format('%s.%s|%s', schemaname, relname,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname), false, true, '')))[1]::text)
FROM pg_stat_user_tables ORDER BY 1;
ROLLBACK;
SQL

( cd "$dir" && sha256sum base.dump esquema.sql contenido.txt filas.txt > SHA256SUMS )
echo "Respaldo listo en $dir"
cat "$dir/filas.txt"
