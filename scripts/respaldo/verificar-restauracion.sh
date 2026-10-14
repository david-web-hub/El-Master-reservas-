#!/usr/bin/env bash
# Comprueba que un respaldo de scripts/respaldo/respaldo-postgres.sh se puede restaurar.
#
# Uso:
#   RESTAURAR_URL='postgres://.../base_vacia' scripts/respaldo/verificar-restauracion.sh respaldos/pg-<fecha>
#
# - Verifica las sumas SHA-256 del respaldo.
# - Restaura base.dump en RESTAURAR_URL, que debe ser una base VACÍA y distinta
#   de producción (su nombre debe contener "restaur", "test" o "prueba").
# - Compara el número de filas de cada tabla con filas.txt.
# Nunca imprime la dirección de la base. No toca la base de origen.
set -euo pipefail

dir="${1:-}"
if [[ -z "$dir" || ! -f "$dir/base.dump" || ! -f "$dir/filas.txt" ]]; then
  echo "Uso: RESTAURAR_URL=... $0 <carpeta del respaldo con base.dump y filas.txt>" >&2
  exit 2
fi
if [[ -z "${RESTAURAR_URL:-}" ]]; then
  echo "Define RESTAURAR_URL con una base vacía para la prueba." >&2
  exit 2
fi
for cmd in pg_restore psql sha256sum; do
  command -v "$cmd" >/dev/null || { echo "Falta $cmd" >&2; exit 2; }
done
export PGSSLMODE="${PGSSLMODE:-require}"

nombre="$(psql "$RESTAURAR_URL" -X -A -t -c 'SELECT current_database()')"
if [[ ! "$nombre" =~ (restaur|test|prueba) ]]; then
  echo "La base de prueba \"$nombre\" debe contener restaur, test o prueba en su nombre." >&2
  exit 2
fi
tablas="$(psql "$RESTAURAR_URL" -X -A -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
if [[ "$tablas" != "0" ]]; then
  echo "La base \"$nombre\" no está vacía ($tablas tablas). Usa una base nueva." >&2
  exit 2
fi

echo "1/3 Sumas de verificación"
( cd "$dir" && sha256sum --check --quiet SHA256SUMS )

echo "2/3 Restaurando en \"$nombre\""
pg_restore --dbname "$RESTAURAR_URL" --no-owner --no-privileges --exit-on-error "$dir/base.dump"

echo "3/3 Comparando filas por tabla"
actual="$(mktemp)"
psql "$RESTAURAR_URL" -X -q -A -t -v ON_ERROR_STOP=1 > "$actual" <<'SQL'
SELECT format('%s.%s|%s', schemaname, relname,
  (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname), false, true, '')))[1]::text)
FROM pg_stat_user_tables ORDER BY 1;
SQL
if diff <(sort "$dir/filas.txt") <(sort "$actual"); then
  echo "RESTAURACIÓN VERIFICADA: $(wc -l < "$actual") tablas con las mismas filas que el respaldo."
  rm -f "$actual"
else
  echo "LA RESTAURACIÓN NO COINCIDE con filas.txt (diferencias arriba)." >&2
  rm -f "$actual"
  exit 1
fi
