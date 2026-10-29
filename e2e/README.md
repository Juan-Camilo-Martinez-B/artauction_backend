# Prueba de punta a punta

Recorre ArtAuction AI como lo usa el frontend: solo por el api-gateway, por REST y Socket.IO, contra la plataforma real levantada con docker compose. No lee bases de datos ni llama a servicios internos. Si algo pasa aquí, pasa en el navegador.

Usa `node:test`, `fetch` y `socket.io-client`. Los archivos son TypeScript que Node 24 ejecuta directamente (type stripping), sin compilar.

## Qué cubre

| Archivo | Flujo |
|---|---|
| `01-identity.test.ts` | health, OpenAPI publicado, registro, login, sesión, refresh, 401, 404, 400 y JSON mal formado |
| `02-publishing-and-review.test.ts` | publicar una obra completa (hash, subida firmada a Garage, envío); auditoría con IA; un anacronismo que va a revisión manual sin IA; la cola del administrador con sus evidencias; la resolución; la galería propia del vendedor |
| `03-auction-wallet-gallery.test.ts` | recarga idempotente; apertura de una sala; pujas por REST y por Socket.IO con reserva TCC; repetición idempotente; cierre con ganador; liquidación (canje, devolución, abono al vendedor menos la comisión); obra ganada en la galería, el feed y los avisos; sala 3D; follows |

Los archivos corren en orden (`--test-concurrency=1`), porque el tercero espera el cierre real de una sala.

## Correr

Con la plataforma levantada (`npm run compose:up` en la raíz del monorepo):

```bash
npm run e2e
```

Tarda unos dos minutos. La mayor parte es la sala de la prueba 03, que abre a los 8 s y cierra a los 55 s, más la espera del programador.

Variables opcionales:

| Variable | Por defecto | Para qué |
|---|---|---|
| `E2E_BASE_URL` | `http://127.0.0.1:3001` | gateway contra el que se corre |
| `E2E_SEED_PASSWORD` | `DevPassword!234` | contraseña de las cuentas de la semilla |
| `E2E_ADMIN_EMAIL` | `admin@artauction.local` | administrador de la semilla |
| `E2E_SELLER_EMAIL` | `seller@artauction.local` | vendedor de la semilla, dueño de las obras que se subastan |

Para no tocar la plataforma de trabajo, se puede levantar una copia aislada en otros puertos:

```bash
export FRONTEND_PORT=13000 GATEWAY_PORT=13001 MEDIA_PORT=13902 S3_PORT=13900
docker compose -p artauction-verify --env-file secrets/service-clients.env --env-file secrets/compose.env up -d --build
E2E_BASE_URL=http://127.0.0.1:13001 npm run e2e
docker compose -p artauction-verify --env-file secrets/service-clients.env --env-file secrets/compose.env down -v
```

## Decisiones

- **Datos propios por corrida.** Cada corrida registra sus cuentas con un sufijo aleatorio (`RUN_ID`), así se puede repetir sobre la misma base. Solo el administrador y el vendedor de la semilla vienen de `artauction_bd`, porque esos roles no se crean por la API.
- **Imágenes distintas en cada corrida.** `texturedPng` genera un PNG con bloques de luminancia aleatoria, sembrados por la obra y la corrida. El hash perceptual mira la estructura de baja frecuencia: con la misma imagen en dos corridas, la auditoría la marcaría como duplicada de otro vendedor (`DUPLICATE_IMAGE_OTHER_SELLER`), que es justo lo que debe hacer.
- **El veredicto del modelo no se fija.** Sin `GEMINI_API_KEY`, como en CI, decide la evaluación local, que es determinista: la obra coherente debe publicarse. Con Gemini, la prueba exige que la decisión sea de la IA y no de una regla; si el modelo la publica, también comprueba la subasta. La subasta tras una aprobación se prueba siempre con la resolución del administrador.
- **Esperas con plazo, no pausas fijas.** `eventually` repite una consulta hasta que se cumple o vence el plazo, porque los efectos llegan por eventos.

## En CI

El job `compose and e2e` de `.github/workflows/ci.yml` clona `artauction_bd` y `artauction_frontend` como carpetas hermanas, genera secretos efímeros, levanta compose, corre esta suite y, si falla, sube los logs de compose como artefacto.
