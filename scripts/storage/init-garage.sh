#!/usr/bin/env bash
# Inicializa el almacenamiento S3 local (Garage) de forma idempotente:
#   1. Asigna capacidad al nodo y aplica el layout (una sola vez).
#   2. Crea el bucket de imagenes y habilita su lectura publica por el endpoint web.
#   3. Crea una llave para catalog-service con lectura y escritura SOLO de ese bucket.
#   4. Crea una llave de administracion del bucket para fijar CORS.
#   5. Escribe las credenciales en secrets/storage.env (no versionado).
# Requiere el contenedor en marcha (docker compose up -d garage).
set -euo pipefail

CONTAINER="${GARAGE_CONTAINER:-artauction-garage}"
BUCKET="${S3_BUCKET:-artauction-media}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="${root}/secrets/storage.env"

# La CLI escribe sus logs INFO en stderr; se filtran sin ocultar los errores.
garage() {
  MSYS_NO_PATHCONV=1 docker exec "${CONTAINER}" /garage "$@" 2> >(grep -v ' INFO ' >&2)
}

node_id="$(garage status | awk '/^[0-9a-f]{16}/ { print $1; exit }')"
if [[ -z "${node_id}" ]]; then
  echo "No se encontro el nodo de Garage" >&2
  exit 1
fi

if garage layout show | grep -q "No nodes currently have a role"; then
  garage layout assign -z dc1 -c 2G "${node_id}" >/dev/null
  garage layout apply --version 1 >/dev/null
  echo "layout aplicado en ${node_id}"
else
  echo "layout ya configurado"
fi

if ! garage bucket info "${BUCKET}" >/dev/null 2>&1; then
  garage bucket create "${BUCKET}" >/dev/null
  echo "bucket ${BUCKET} creado"
fi
garage bucket website --allow "${BUCKET}" >/dev/null

ensure_key() {
  local name="$1"
  if ! garage key info "${name}" >/dev/null 2>&1; then
    garage key create "${name}" >/dev/null
    echo "llave ${name} creada"
  fi
  garage key info "${name}" --show-secret
}

read_field() {
  awk -v field="$1" -F': *' '$1 ~ field { print $2; exit }'
}

catalog_info="$(ensure_key catalog-service)"
admin_info="$(ensure_key storage-admin)"
garage bucket allow --read --write "${BUCKET}" --key catalog-service >/dev/null
garage bucket allow --read --write --owner "${BUCKET}" --key storage-admin >/dev/null

mkdir -p "$(dirname "${out}")"
umask 077
{
  echo "# Credenciales S3 de Garage. No compartir ni versionar."
  echo "S3_ENDPOINT=http://localhost:3900"
  echo "S3_REGION=garage"
  echo "S3_BUCKET=${BUCKET}"
  echo "S3_ACCESS_KEY_ID=$(read_field 'Key ID' <<<"${catalog_info}")"
  echo "S3_SECRET_ACCESS_KEY=$(read_field 'Secret key' <<<"${catalog_info}")"
  echo "MEDIA_PUBLIC_BASE_URL=http://${BUCKET}.web.garage.localhost:3902"
  echo ""
  echo "# Solo para scripts de administracion del bucket (CORS)."
  echo "S3_ADMIN_ACCESS_KEY_ID=$(read_field 'Key ID' <<<"${admin_info}")"
  echo "S3_ADMIN_SECRET_ACCESS_KEY=$(read_field 'Secret key' <<<"${admin_info}")"
} >"${out}"
echo "credenciales en secrets/storage.env"

node "${root}/scripts/storage/apply-cors.mjs"
