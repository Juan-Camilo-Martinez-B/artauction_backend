# Plan de migracion a microservicios

Estado: completado (F0 a F9). Rama: `feat/microservices`.

La arquitectura resultante, con sus diagramas, está en [arquitectura.md](arquitectura.md). Este documento queda como registro del plan y de cómo se ejecutó.

## Objetivo

Pasar el monolito modular NestJS a microservicios con bajo acoplamiento y alta cohesion, sin romper el frontend. Al terminar:

- `docker compose up` levanta todos los servicios, el gateway, Postgres y Mongo.
- El frontend sigue funcionando contra `http://localhost:3001` con el mismo contrato REST y Socket.IO. El unico cambio es la cabecera `Idempotency-Key` en la recarga del bolsillo.
- Cada servicio tiene pruebas por capa y su job de CI.
- La arquitectura queda documentada: este plan, los ADR en `adr/` y un README por servicio.

Solo se simulan la pasarela de pagos y el dinero real. Todo lo demas es funcional.

## Servicios

| Servicio | Responsabilidad | Datos propios |
|---|---|---|
| `api-gateway` | REST y Socket.IO en `:3001`, rate limit, CORS, composicion de lecturas | ninguno |
| `identity-service` | Usuarios, login, refresh rotativo, firma JWT RS256 | PG `identity`, Mongo `artauction_identity` |
| `catalog-service` | Lotes, categorias, imagenes, storage, hash perceptual, ciclo de vida del lote, revision manual | PG `catalog` |
| `auction-service` | Subastas, pujas, apertura y cierre programados, ventas, stream en vivo | PG `auction` |
| `wallet-service` | Saldo, retenciones TCC, ledger, recargas con pasarela simulada | PG `wallet` |
| `audit-service` | Cola propia (`audit_requests`), expediente de evidencias, worker, resumenes e informes | PG `audit`, Mongo `artauction_audit` |
| `ai-service` | Unico dueno de `GEMINI_API_KEY`; REST hacia Gemini con circuit breaker | ninguno |
| `gallery-service` | Galeria 3D personal, galeria social, follows, feed | PG `gallery`, Mongo `artauction_gallery` |
| `notification-service` | Notificaciones | Mongo `artauction_notification` |

El antiguo modulo de administracion se vuelve un caso de uso de `catalog-service` (`ResolveManualReview`).

## Estructura de cada servicio

```
services/<servicio>/src/
  api/                     unica frontera del servicio
    grpc/                  servidor gRPC y mapeo proto <-> DTO de aplicacion
    clients/               clientes gRPC a otros servicios (implementan puertos internos)
    events/                relay del outbox y handlers de eventos entrantes
  internal/
    domain/                entidades, value objects y reglas puras
    application/           casos de uso y puertos
    infrastructure/        repositorios, outbox e inbox, planificadores
  main.ts
```

Reglas, verificadas por `eslint.config.mjs`:

- `internal` no importa `api`, `@artauction/contracts`, `@grpc/*` ni codigo de otro servicio.
- `internal/domain` no importa frameworks ni persistencia.
- `internal/application` depende de puertos, no de `infrastructure`.

Paquetes compartidos, sin reglas de negocio:

- `packages/contracts`: `.proto` versionados (`artauction.<svc>.v1` y eventos en `artauction.<svc>.events.v1`) y el codigo TS generado.
- `packages/platform`: logger, configuracion, errores de dominio, resiliencia, concurrencia y helpers gRPC.

## Comunicacion

- Entre servicios: gRPC sobre HTTP/2 (`@grpc/grpc-js`). Cada llamada lleva deadline y correlation id; solo se reintentan operaciones idempotentes. Cada servicio expone `grpc.health.v1`.
- Tiempo real: `auction.v1.AuctionService/WatchAuction` es un stream de servidor que el gateway traduce a los eventos Socket.IO actuales.
- Gemini: REST. Es la interfaz oficial; gRPC con API key no esta documentado. Queda encapsulado en `ai-service` como capa anticorrupcion.
- Seguridad: identity firma JWT con RS256 y los demas servicios verifican con la clave publica. El gateway reenvia el token en la metadata gRPC y cada servicio lo valida (zero trust). TLS en gRPC se activa por entorno.

## Flujos que cruzan servicios

| Flujo | Diseno |
|---|---|
| Pujar | auction serializa por subasta y bloquea la fila; `wallet.TryHold` reserva con la clave de idempotencia; la puja y el evento se guardan en una transaccion local; el outbox confirma con `wallet.ConfirmHold`. Una reserva sin confirmar caduca por TTL. |
| Retirarse | auction desactiva la puja; el outbox llama a `wallet.ReleaseHold`. |
| Cierre con ganador | transaccion local: subasta `CERRADA`, venta y evento `AuctionClosed`. Consumidores: wallet `SettleHolds`, catalog `MarkSold`, gallery `GrantWonLot`, notification. |
| Cierre sin pujas | evento `AuctionRescheduled`: wallet libera retenciones y catalog vuelve el lote a `PUBLICADA`. |
| Auditoria | catalog emite `LotSubmitted`; audit encola; el worker pide el lote a catalog y llama a `ai.AuditArtwork`; `AuditCompleted` llega a catalog, auction y notification. |
| Lecturas compuestas | el gateway combina `catalog.ListLots` con `auction.BatchGetSummaries`. |
| Recarga | `Idempotency-Key` unica en `wallet.payment_orders`. |

Cada esquema tiene tablas `outbox` e `inbox`. La inbox guarda los ids de eventos procesados y hace idempotente a cada consumidor.

## Fases

| Fase | Contenido | Verificacion |
|---|---|---|
| F0 | Monorepo con workspaces, `platform`, reglas de fronteras, ADR | lint, typecheck y pruebas en verde; el monolito sigue corriendo |
| F1 | Contratos `.proto` v1 y generacion de codigo | `buf lint` y tipos generados |
| F2 | Repo `artauction_bd`: esquemas por servicio, roles, outbox e inbox, sin FK entre contextos, vistas de compatibilidad | migracion sin perdida y monolito funcionando sobre las vistas |
| F3 | identity-service y gateway base | login desde el frontend a traves del gateway |
| F4 | catalog-service | catalogo y publicacion desde el frontend |
| F5 | wallet-service y cambio en el frontend | doble clic en recarga sin doble cobro |
| F6 | auction-service y puente Socket.IO | sala en vivo y prueba de pujas concurrentes |
| F7 | ai-service y audit-service | publicar, auditar y programar subasta |
| F8 | gallery-service, notification-service y revision manual | galeria 3D, feed y notificaciones |
| F9 | Compose completo, retiro del monolito y de las vistas, e2e, CI, README | `docker compose up` y frontend completo |

Mientras duro la migracion, el gateway reenvio al monolito las rutas que aun no se habian migrado (Strangler Fig). Asi la aplicacion funciono al cerrar cada fase.

## Cierre de F9

- `compose.yaml` levanta en un solo comando la infraestructura, los jobs de migracion y almacenamiento, los nueve servicios y el frontend (`npm run compose:up`).
- Se retiraron el monolito (`src/`, sus pruebas, Prisma y dependencias) y el proxy del gateway. Las rutas desconocidas responden 404.
- El gateway publica OpenAPI en `/docs` y `/docs-json`.
- `artauction_bd` 0.8.0 retira las vistas de compatibilidad y los esquemas `pgboss` y `audit_queue` (migracion `0021`).
- La prueba de punta a punta (`e2e/`) recorre la plataforma por el gateway. La CI la corre sobre compose en cada PR y en `main`, junto con `buf breaking`.
- La e2e encontro un defecto que las pruebas unitarias no veian: audit-service no escribia `summaryId` en los informes de Mongo, y el indice unico de `artauction_bd` rechazaba desde el segundo informe en una base nueva. Ahora el campo repite el id del resumen.

## Versionado

- Ramas: `feat/microservices` (backend), `feat/schema-per-service` (base de datos), `feat/topup-idempotency` (frontend).
- Un commit por paso significativo, en Conventional Commits. Push al cerrar cada fase, previa confirmacion.

## Decisiones que cambiaron durante la ejecucion

- Al vender, el vendedor si recibe artacoins: wallet abona el precio menos la comision de la plataforma (`PLATFORM_FEE_BPS`, 10 % por defecto), registrada en `wallet.platform_fees`. El plan original solo descontaba al ganador.
- La auditoria no llama a la IA con imagenes: arma un expediente de evidencias y decide por reglas cuando hay un conflicto critico (ADR 0009).
