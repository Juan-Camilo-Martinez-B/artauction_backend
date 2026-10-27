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

Estado: migrados `identity-service` y `api-gateway`. El resto de rutas lo atiende el monolito detrás del gateway.

### Levantar la pila en local

```bash
node scripts/generate-keys.mjs                 # una vez: secrets/jwt y secrets/service-clients.env
npm run build:workspaces
npm start -w @artauction/identity-service      # gRPC :50051
npx nest start                                 # monolito :3002 (PORT=3002 y JWT_PUBLIC_KEY_PATH en .env)
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

`identidad`, `catalogo`, `subastas`, `auditoria-ia`, `galerias-social`, `notificaciones`, `administracion`.

No hay dependencias circulares. Cada módulo sigue controller → service → repository. La infraestructura compartida vive en `src/infra` (Postgres, Mongo, Cloud Storage, pg-boss, adaptadores de IA) y no importa módulos de negocio.

## Reglas de dominio que este servicio garantiza

**Ciclo de vida del lote.** `BORRADOR → PENDIENTE_AUDITORIA → PUBLICADA | REVISION_MANUAL → EN_SUBASTA → VENDIDA`. Si nadie puja, vuelve a `PUBLICADA`.

**Auditoría.** Nunca corre dentro de una petición HTTP. El alta de una obra encola un trabajo pg-boss. El worker llama al puerto `AiAuditPort` (adaptador Gemini o adaptador fake). Reintentos con backoff exponencial, concurrencia limitada y circuit breaker. Si el proveedor falla, la plataforma sigue operando y el lote permanece auditable. El informe completo (modelo, versión de prompt, entrada y fecha) queda en Mongo; el resumen y el score, en Postgres.

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

`/me/gallery` es la sala 3D de quien inicia sesión. El identificador sale del access token. `POST /me/gallery/generate` convierte el cuestionario en una configuración validada. Sin `GEMINI_API_KEY` lo hace el adaptador local, el mismo criterio que la auditoría.

## Estado

Fase 0: andamiaje. El bootstrap de NestJS y los módulos llegan en la fase de backend. El catálogo filtrable y la galería personal ya están en el servicio.
