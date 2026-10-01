# ArtAuction AI — Backend

API y tiempo real de **ArtAuction AI**. Monolito modular en NestJS: identidad, catálogo, subastas, auditoría con IA, galerías sociales, notificaciones y administración.

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

**Ciclo de vida del lote.** `BORRADOR → PENDIENTE_AUDITORIA → APROBADO | REVISION_MANUAL → EN_SUBASTA → CERRADO`.

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

## Estado

Fase 0: andamiaje. El bootstrap de NestJS y los módulos llegan en la fase de backend.
