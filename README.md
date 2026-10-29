# ArtAuction AI — Backend

API y tiempo real de **ArtAuction AI**. Monolito modular en NestJS: identidad, catálogo, subastas, auditoría con IA, galerías sociales, notificaciones y administración.

## Migración a microservicios (en curso)

La rama `feat/microservices` convierte este repositorio en un monorepo de microservicios que se comunican por gRPC sobre HTTP/2. El monolito de `src/` sigue funcionando mientras dura la migración: el gateway le reenvía las rutas que todavía no se han migrado (Strangler Fig).

```
packages/platform     utilidades técnicas (logger, config, errores, resiliencia, verificación JWT RS256)
packages/contracts    contratos .proto versionados y código generado con ts-proto
packages/service-kit  capa api común: servidor gRPC con health, handlers, clientes con deadline
services/<servicio>   un microservicio por contexto, con capas internal y api
scripts/              generate-keys.mjs: claves RS256 y secretos de clientes en secrets/
docs/arquitectura     plan, mapa de contextos y decisiones (ADR)
src/                  monolito, se retira en la fase F9
```

Estado: migrados `identity-service`, `catalog-service`, `wallet-service`, `auction-service`, `ai-service`, `audit-service` y `api-gateway`, que ya sirve la sala en vivo por Socket.IO. La auditoría arma un expediente de evidencias local y la IA razona sobre él sin ver imágenes (ADR 0009); ai-service es el único con la clave de Gemini. El resto de rutas lo atiende el monolito detrás del gateway. El monolito también expone un servidor gRPC legado (`LEGACY_GRPC_PORT`) que consume eventos en nombre de gallery y notification mientras esos servicios no existen, arranca con `AUCTIONS_IN_SERVICE=true` para no abrir ni cerrar salas y pide el diseño de galerías a ai-service.

### Levantar la pila en local

```bash
node scripts/generate-keys.mjs                 # una vez: claves RS256, secretos de servicio y de Garage
docker compose up -d                           # en la carpeta raíz: Postgres, Mongo y Garage (S3)
bash scripts/storage/init-garage.sh            # una vez: bucket, llaves y CORS en secrets/storage.env
npm run build:workspaces
npm start -w @artauction/identity-service      # gRPC :50051
npx nest start                                 # monolito :3002 y gRPC legado :50090
npm start -w @artauction/catalog-service       # gRPC :50052
npm start -w @artauction/wallet-service        # gRPC :50053
npm start -w @artauction/auction-service       # gRPC :50054, programador de salas
npm start -w @artauction/ai-service            # gRPC :50055, fachada de Gemini
npm start -w @artauction/audit-service         # gRPC :50056, auditoria por expediente de evidencias
npm start -w @artauction/api-gateway           # HTTP y Socket.IO :3001, el frontend no cambia
```

Cada servicio tiene su `.env.example`. Las contraseñas de base de datos de cada servicio se crean con `npm run roles` en `artauction_bd`.

Lectura recomendada: [plan](docs/arquitectura/plan-microservicios.md), [mapa de contextos](docs/arquitectura/contextos.md) y [ADR](docs/arquitectura/adr).

Comandos del monorepo:

| Comando | Qué hace |
|---|---|
| `npm run build:workspaces` | Compila paquetes y servicios |
| `npm run typecheck:workspaces` | Typecheck de paquetes y servicios |
| `npm run test:workspaces` | Pruebas de paquetes y servicios |
| `npm run lint:workspaces` | Lint con las reglas de fronteras entre capas |

Este directorio es un repositorio Git independiente. No importa código de los repos hermanos por ruta relativa.

Contratos que publica:

- OpenAPI, en `docs/openapi`, consumido por el frontend.
- Catálogo versionado de eventos WebSocket (Socket.IO).

Contrato que consume:

- Esquemas de Postgres y Mongo publicados por `artauction-database` con tags semánticos. Este servicio no redefine el modelo en una copia divergente: aplica el esquema versionado.

## Módulos

`identidad`, `catalogo`, `subastas`, `galerias-social`, `notificaciones`, `administracion`. El módulo `auditoria-ia` se retiró en F7: la auditoría vive en audit-service y ai-service.

No hay dependencias circulares. Cada módulo sigue controller → service → repository. La infraestructura compartida vive en `src/infra` (Postgres, Mongo, almacenamiento) y no importa módulos de negocio.

## Reglas de dominio que este servicio garantiza

**Ciclo de vida del lote.** `BORRADOR → PENDIENTE_AUDITORIA → PUBLICADA | REVISION_MANUAL → EN_SUBASTA → VENDIDA`. Si nadie puja, vuelve a `PUBLICADA`.

**Auditoría.** Nunca corre dentro de una petición HTTP. Desde F7 la hace audit-service: el envío de una obra emite `LotSubmitted`, audit-service arma un expediente de evidencias (imágenes, metadatos, duplicados y reglas deterministas) y ai-service lo evalúa sin ver imágenes. Reintentos con backoff y revisión manual como respaldo: si el proveedor falla, la plataforma sigue operando. El informe completo queda en Mongo (`artauction_audit`); el resumen y el score, en Postgres. Ver el README de audit-service y el ADR 0009.

**Pujas.** Transacción con `SELECT … FOR UPDATE` sobre el lote. Se validan estado, plazo e incremento mínimo. Cada puja lleva `idempotencyKey`. No se puede pujar el lote propio. Una puja en los últimos 30 s extiende el cierre otros 30 s. El precio actual no decrece. El reloj es del servidor.

**Hilos.** La E/S permanece en el event loop. El hash perceptual y el análisis de anomalías de pujas corren en un pool de `worker_threads` de tamaño `vCPU - 1`. El cierre de subastas lo hace un planificador idempotente.

**Autorización.** Se evalúa por recurso. Una obra privada no aparece en ninguna respuesta a un tercero.

## Estructura

```
src/modules     un directorio por módulo de negocio
src/common      filtros, guards compartidos, pipes, tipos transversales
src/infra       postgres, mongo, storage, queue, ai
src/workers     pool de worker_threads y worker de la cola
test            unitarias e integración, incluidas pujas concurrentes
docs/openapi    especificación publicada
```

## Seguridad

Argon2 para contraseñas. Access token corto y refresh rotativo. Validación de entrada con class-validator. Rate limiting. CORS limitado a `CORS_ORIGINS`. Secretos solo por entorno o Secret Manager.

## Convenciones

- Commits en [Conventional Commits](https://www.conventionalcommits.org/).
- Rama `main`. Trabajo en `feat/...`, integración con `merge --no-ff` en los hitos grandes.
- TypeScript estricto, ESLint y Prettier. `commitlint.config.cjs` fija el mensaje; Husky se engancha al instalar el toolchain.
- Logs estructurados. Cobertura objetivo de al menos 70 % en subastas y auditoría.
- `.env.example` documenta las variables. Ningún secreto entra al historial.

## Imagen

`Dockerfile` multi-stage. El proceso escucha en el puerto `8080`. En el MVP de Cloud Run, `max-instances=1` para que la sala Socket.IO no se parta entre instancias.

## Catálogo y galería personal

`GET /lots` responde `{ items, total, page, pageSize }` y filtra por `q`, `category`, `representation` y `sort`. Las categorías viven en `GET /lots/categories`.

`/me/gallery` es la sala 3D de quien inicia sesión. El identificador sale del access token. `POST /me/gallery/generate` convierte el cuestionario en una configuración validada. La propuesta la pide a ai-service (único con la clave de Gemini) y se valida con el esquema de la galería; sin modelo, o si ai-service no responde, la hace el adaptador local.

## Estado

Fase 0: andamiaje. El bootstrap de NestJS y los módulos llegan en la fase de backend. El catálogo filtrable y la galería personal ya están en el servicio.
