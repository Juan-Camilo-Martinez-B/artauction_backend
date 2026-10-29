# ADR 0007: almacenamiento S3 de imágenes con URLs prefirmadas

Estado: aceptado.

## Contexto

Publicar una obra no funcionaba en ningún entorno: el monolito firmaba subidas hacia una ruta `/dev-uploads` que no existía y solo mostraba imágenes cuya clave ya fuera una URL https. La aplicación tiene que ser funcional y realista.

## Decisión

- Las imágenes viven en un bucket S3. `catalog-service` firma una **URL prefirmada SigV4** por subida y el navegador sube el archivo directo al bucket; el backend nunca recibe los bytes.
- El Content-Type se firma: el bucket rechaza una subida con otro tipo (por ejemplo HTML).
- Cada subida usa una clave nueva bajo `lots/<id>/`; `RegisterImage` solo acepta claves de la propia obra o URLs https.
- Las imágenes se leen por un endpoint público de solo lectura (`MEDIA_PUBLIC_BASE_URL`).
- En local el servidor S3 es **Garage v2.1.0**. Se eligió MinIO, pero ya no publica imágenes Docker (ni en Docker Hub ni en Quay). Garage es S3-compatible, estable y su versión se puede fijar.
- `scripts/storage/init-garage.sh` deja el nodo, el bucket, la lectura pública, una llave de catalog con permisos solo sobre ese bucket, una llave de administración y CORS. Los secretos van a `secrets/`.
- El SDK de AWS se configura con `requestChecksumCalculation: 'WHEN_REQUIRED'`: por defecto firma el CRC32 de un cuerpo vacío y el servidor rechaza la imagen real.

## Consecuencias

- El mismo código sirve con AWS S3 o con la interoperabilidad S3 de Cloud Storage cambiando solo la configuración.
- Una URL prefirmada de `PUT` no limita el tamaño del archivo. El frontend redimensiona antes de subir; en producción conviene una política de tamaño en el bucket o pasar a `POST` prefirmado con condiciones.
- Los navegadores resuelven `*.localhost` a la máquina local, por eso la base pública local es `http://artauction-media.web.garage.localhost:3902`.
