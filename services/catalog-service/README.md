# catalog-service

Obras, imágenes, categorías y el **ciclo de vida del lote** de ArtAuction AI. Es el dueño del esquema `catalog`. Expone `artauction.catalog.v1.CatalogService` y `CatalogEventHandlerService` por gRPC (puerto `50052`) y publica eventos por su outbox.

## Ciclo de vida del lote

```
BORRADOR -> PENDIENTE_AUDITORIA -> PUBLICADA | REVISION_MANUAL -> EN_SUBASTA -> VENDIDA
                                      ^             |                 |
                                      +-- revisión manual --+         +-> PUBLICADA (sin pujas)
```

Desde `REVISION_MANUAL`, un administrador también puede volver a `PENDIENTE_AUDITORIA` para pedir otra auditoría.

La máquina de estados es una lista de adyacencia en `internal/domain/lot-status.ts`. Cada cambio de estado es **optimista**: solo se aplica si el lote sigue en el estado leído, así dos peticiones simultáneas no pueden pisarse.

## Qué resuelve

| RPC | Caso de uso | Reglas |
|---|---|---|
| `ListPublicLots`, `GetRelatedLots`, `BatchGetPublicLots` | consultas | Solo obras `PUBLIC` en `APROBADO`, `PUBLICADA` o `EN_SUBASTA`. Paginación acotada a 60. Orden estable (desempate por id). |
| `GetLot` | `GetLotForViewer` | Una obra privada responde 404 a un tercero, igual que una inexistente. |
| `CreateLot` | `CreateLot` | Solo `SELLER` o `ADMIN`. Valida medidas (0,1 a 2000 cm, dos decimales) y exige profundidad a un objeto 3D. Emite `LotCreated`. |
| `SignUpload` | `SignImageUpload` | URL prefirmada S3 (SigV4) con el Content-Type firmado; clave nueva en cada subida (`lots/<id>/<pos>-<aleatorio>`). |
| `RegisterImage` | `RegisterLotImage` | La clave tiene que ser de esa obra o una URL https: una obra no puede apropiarse de la imagen de otra. |
| `HashImage` | `HashLotImage` | dHash de 64 bits en un pool de `worker_threads` (vCPU − 1); el event loop no se bloquea. |
| `SubmitLot` | `SubmitLot` | `BORRADOR -> PENDIENTE_AUDITORIA` y emite `LotSubmitted`. |
| `ResolveManualReview` | `ResolveManualReview` | Solo `ADMIN`. Publica (emite `LotPublished`), devuelve a borrador con un motivo (emite `LotReturnedToDraft`) o pide otra auditoría (emite `LotSubmitted`). Ver «Revisión manual». |
| `UpdateLot` | `UpdateLot` | Solo el vendedor dueño y solo en `BORRADOR`: corrige la ficha de una obra devuelta. |
| `ListMyLots` | `ListMyLots` | Las obras del vendedor que llama, en todos sus estados, con su última revisión. |
| `BatchGetLotSnapshots` | consulta interna | Solo con token de servicio; ignora la visibilidad. |
| `ListReviewQueue` | `GET /admin/reviews` | Solo `ADMIN`: obras en revisión manual, la más antigua primero (hasta 50). |
| `FindSimilarImages` | consulta interna | Solo audit-service: imágenes de otras obras a distancia de Hamming ≤ `max_distance` del dHash. Los hashes no salen de catalog. |

Eventos que consume (`CatalogEventHandlerService`), cada uno una sola vez por `event_id` y solo desde el estado esperado: `AuditCompleted` (veredicto), `AuctionStarted` (`EN_SUBASTA`), `AuctionClosed` (`VENDIDA`), `AuctionRescheduled` (`PUBLICADA`).

## Outbox

El cambio de estado y su evento se guardan en la **misma transacción** (`catalog.outbox`). `OutboxRelay` de `@artauction/platform` los entrega por gRPC a cada consumidor con un token de servicio, en orden por obra y con backoff. Destinos:

| Evento | Consumidor | URL |
|---|---|---|
| `LotCreated` | gallery (galería propia del vendedor) | `GALLERY_EVENTS_GRPC_URL` |
| `LotSubmitted` | audit (encola la auditoría) | `AUDIT_EVENTS_GRPC_URL` |
| `LotPublished` | auction (programa la subasta) | `AUCTION_EVENTS_GRPC_URL` |
| `LotReturnedToDraft` | notification (aviso al vendedor con el motivo) | `NOTIFICATION_EVENTS_GRPC_URL` |

## Revisión manual

Cada decisión del administrador queda en `catalog.lot_reviews`, en la misma transacción que el cambio de estado:

- **Aprobar:** publica la obra. Si la auditoría no estimó precio (evaluación fallida o sin rango), el administrador **debe** fijar el rango en artacoins enteras. Si lo fija, reemplaza el de la auditoría, y la subasta sale del punto medio.
- **Devolver a borrador:** exige un motivo de 10 a 500 caracteres. El vendedor lo recibe como aviso, ve la obra como devuelta en «Mis obras», la corrige (`UpdateLot`, imagen incluida) y la reenvía (`SubmitLot`).
- **Re-auditar:** vuelve a pedir la auditoría, por ejemplo cuando Gemini vuelve a responder después de una evaluación local.

La ficha y la imagen **solo cambian en borrador**: una obra auditada no puede cambiar de foto ni de datos sin pasar otra vez por la auditoría.
## Imágenes

El navegador sube la imagen **directo al bucket** con la URL prefirmada; el backend nunca recibe el archivo. Las imágenes se leen desde la base pública `MEDIA_PUBLIC_BASE_URL`. En local el almacenamiento es Garage (S3-compatible, ver ADR 0007); en producción sirve cualquier S3 o la interoperabilidad S3 de Cloud Storage sin cambiar código.

El Content-Type queda firmado: un `PUT` con otro tipo (por ejemplo `text/html`) se rechaza con 403, así nadie puede subir una página que el endpoint web serviría como HTML.

## Estructura

```
src/
  api/grpc/            CatalogService y CatalogEventHandlerService, mapeo proto <-> dominio
  api/events/          rutas del outbox: evento de dominio -> mensaje protobuf -> consumidor
  internal/
    domain/            Lot, máquina de estados, alta de obra, URL de imagen, eventos
    application/       consultas, comandos, handlers de eventos y puertos
    infrastructure/    Prisma (esquema catalog), firmador S3, pool de hash y su worker
  catalog.module.ts    raíz de composición
```

## Ejecutar

Con toda la plataforma, `npm run compose:up` en la raíz: el job `storage-setup` crea el bucket, las llaves y el CORS. Para desarrollarlo solo, sobre el Garage de la carpeta raíz:

```bash
bash scripts/storage/init-garage.sh            # en la raíz del monorepo, una vez
cp .env.example .env                           # completar con secrets/storage.env y service-clients.env
npm run build -w @artauction/catalog-service
npm start -w @artauction/catalog-service
```

## Pruebas

`npm test -w @artauction/catalog-service`: máquina de estados, alta de obra, URLs de imagen, visibilidad, roles, propiedad de claves, revisión manual con su evento e idempotencia de eventos entrantes.
