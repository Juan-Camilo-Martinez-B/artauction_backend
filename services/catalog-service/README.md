# catalog-service

Obras, imágenes, categorías y el **ciclo de vida del lote** de ArtAuction AI. Es el dueño del esquema `catalog`. Expone `artauction.catalog.v1.CatalogService` y `CatalogEventHandlerService` por gRPC (puerto `50052`) y publica eventos por su outbox.

## Ciclo de vida del lote

```
BORRADOR -> PENDIENTE_AUDITORIA -> PUBLICADA | REVISION_MANUAL -> EN_SUBASTA -> VENDIDA
                                      ^             |                 |
                                      +-- revisión manual --+         +-> PUBLICADA (sin pujas)
```

Desde `REVISION_MANUAL`, un administrador también puede volver a `PENDIENTE_AUDITORIA` para pedir otra auditoría.

### Proyectos propios

Al crear una obra se elige el destino (`destination`):

- `CATALOG` (por defecto): nace en `BORRADOR`, privada, y sigue el ciclo de arriba. Solo `SELLER` o `ADMIN`.
- `PERSONAL`: nace en `PERSONAL`, para la galería de su autor. Cualquier cuenta, también `USER`. No se audita, no tiene score ni precio y nunca se subasta. El catálogo público no la lista aunque sea `PUBLIC`, porque filtra por estado; su ficha sí se abre desde la galería pública del autor.

`PERSONAL -> PENDIENTE_AUDITORIA` es **pasar al catálogo** (solo quien vende). La obra se oculta mientras se audita y desde ahí es una obra más del catálogo.

El autor edita la ficha y la imagen en `BORRADOR` y en `PERSONAL`. La visibilidad solo se cambia a mano en un proyecto propio (`SetLotVisibility`); la de una obra del catálogo la decide la auditoría.

La máquina de estados es una lista de adyacencia en `internal/domain/lot-status.ts`. Cada cambio de estado es **optimista**: solo se aplica si el lote sigue en el estado leído, así dos peticiones simultáneas no pueden pisarse.

## Qué resuelve

| RPC | Caso de uso | Reglas |
|---|---|---|
| `ListPublicLots`, `GetRelatedLots`, `BatchGetPublicLots` | consultas | Solo obras `PUBLIC` en `APROBADO`, `PUBLICADA` o `EN_SUBASTA`. Paginación acotada a 60. Orden estable (desempate por id). |
| `GetLot` | `GetLotForViewer` | Una obra privada responde 404 a un tercero, igual que una inexistente. |
| `CreateLot` | `CreateLot` | Al catálogo, solo `SELLER` o `ADMIN`; un proyecto propio (`destination = PERSONAL`), cualquier cuenta. Valida medidas (0,1 a 2000 cm, dos decimales) y exige profundidad a un objeto 3D. Emite `LotCreated` con `personal` y `visibility`. |
| `SignUpload` | `SignImageUpload` | URL prefirmada S3 (SigV4) con el Content-Type firmado; clave nueva en cada subida (`lots/<id>/<pos>-<aleatorio>`). |
| `RegisterImage` | `RegisterLotImage` | La clave tiene que ser de esa obra o una URL https: una obra no puede apropiarse de la imagen de otra. |
| `SignModelUpload`, `RegisterModel`, `RemoveModel` | `SignModelUpload`, `RegisterLotModel`, `RemoveLotModel` | Modelo 3D de una obra `THREE_D`, obligatorio para mostrarla; solo cambia en `BORRADOR` o `PERSONAL`. Ver «Modelo 3D». |
| `HashImage` | `HashLotImage` | dHash de 64 bits en un pool de `worker_threads` (vCPU − 1); el event loop no se bloquea. |
| `SubmitLot` | `SubmitLot` | `BORRADOR` o `PERSONAL` `-> PENDIENTE_AUDITORIA`, privada mientras se audita. Solo quien vende. Emite `LotSubmitted`. |
| `SetLotVisibility` | `SetLotVisibility` | Solo el autor y solo en `PERSONAL`: muestra u oculta el proyecto en su galería pública. Emite `LotVisibilityChanged`. |
| `ResolveManualReview` | `ResolveManualReview` | Solo `ADMIN`. Publica (emite `LotPublished`), devuelve a borrador con un motivo (emite `LotReturnedToDraft`) o pide otra auditoría (emite `LotSubmitted`). Ver «Revisión manual». |
| `UpdateLot` | `UpdateLot` | Solo el autor y solo en `BORRADOR` o `PERSONAL`: corrige una obra devuelta o un proyecto propio. |
| `ListMyLots` | `ListMyLots` | Las obras de quien llama, en todos sus estados y con su última revisión, también sus proyectos propios. |
| `BatchGetLotSnapshots` | consulta interna | Solo con token de servicio; ignora la visibilidad. |
| `ListReviewQueue` | `GET /admin/reviews` | Solo `ADMIN`: obras en revisión manual, la más antigua primero (hasta 50). |
| `FindSimilarImages` | consulta interna | Solo audit-service: imágenes de otras obras a distancia de Hamming ≤ `max_distance` del dHash. Los hashes no salen de catalog. |

Eventos que consume (`CatalogEventHandlerService`), cada uno una sola vez por `event_id` y solo desde el estado esperado: `AuditCompleted` (veredicto), `AuctionStarted` (`EN_SUBASTA`), `AuctionClosed` (`VENDIDA`), `AuctionRescheduled` (`PUBLICADA`).

## Outbox

El cambio de estado y su evento se guardan en la **misma transacción** (`catalog.outbox`). `OutboxRelay` de `@artauction/platform` los entrega por gRPC a cada consumidor con un token de servicio, en orden por obra y con backoff. Destinos:

| Evento | Consumidor | URL |
|---|---|---|
| `LotCreated` | gallery (la obra es de su autor; un proyecto propio se cuelga en su sala) | `GALLERY_EVENTS_GRPC_URL` |
| `LotSubmitted` | audit (encola la auditoría) y gallery (un proyecto que pasa al catálogo deja de ser `PROYECTO`) | `AUDIT_EVENTS_GRPC_URL`, `GALLERY_EVENTS_GRPC_URL` |
| `LotVisibilityChanged` | gallery (muestra u oculta el proyecto en la galería pública) | `GALLERY_EVENTS_GRPC_URL` |
| `LotPublished` | auction (programa la subasta) | `AUCTION_EVENTS_GRPC_URL` |
| `LotReturnedToDraft` | notification (aviso al vendedor con el motivo) | `NOTIFICATION_EVENTS_GRPC_URL` |

## Revisión manual

Cada decisión del administrador queda en `catalog.lot_reviews`, en la misma transacción que el cambio de estado:

- **Aprobar:** publica la obra. Si la auditoría no estimó precio (evaluación fallida o sin rango), el administrador **debe** fijar el rango en artacoins enteras. Si lo fija, reemplaza el de la auditoría, y la subasta sale del punto medio.
- **Devolver a borrador:** exige un motivo de 10 a 500 caracteres. El vendedor lo recibe como aviso, ve la obra como devuelta en «Mis obras», la corrige (`UpdateLot`, imagen incluida) y la reenvía (`SubmitLot`).
- **Re-auditar:** vuelve a pedir la auditoría, por ejemplo cuando el modelo de IA vuelve a responder después de una evaluación local.

La ficha y la imagen **solo cambian en borrador**: una obra auditada no puede cambiar de foto ni de datos sin pasar otra vez por la auditoría.
## Modelo 3D

Una obra tridimensional se muestra con su modelo GLB (glTF 2.0 binario). El frontend acepta también .gltf, .fbx y .obj y los convierte a GLB en el navegador; aquí solo llega GLB. Sin modelo, la obra tridimensional no se muestra (`assertShowable`): no va a auditoría (`SubmitLot`), un proyecto propio no se hace público (`SetLotVisibility`) y nace privado aunque se pida público. Un proyecto propio público no se queda sin modelo: se reemplaza subiendo otro.

1. `SignModelUpload` firma un `PUT` con `Content-Type: model/gltf-binary` a `lots/<obra>/model-<aleatorio>.glb`.
2. `RegisterModel` lee el archivo del bucket por `S3_INTERNAL_ENDPOINT` (o `S3_ENDPOINT` si no está definida: el host firmado es el del navegador y, dentro de Docker, no llega a Garage) y corta en 30 MB. Lo valida con `domain/glb.ts`, un lector propio sin dependencias. Lee solo la cabecera y el bloque JSON, que glTF obliga a traer con el conteo de cada accessor y el mínimo y máximo de las posiciones; por eso funciona igual con geometría comprimida (Draco o meshopt).
   - Rechaza lo que no es glTF 2.0 binario completo, los buffers o texturas fuera del archivo y las extensiones requeridas que la sala no abre.
   - Cuenta los triángulos de cada malla tantas veces como aparece en la escena: entre 1 000 y 300 000.
   - Mide la caja que envuelve el modelo llevando cada malla al mundo con la transformación de sus nodos. Un ciclo o una jerarquía de más de 64 niveles se rechaza.
3. Se guarda en `catalog.lot_models` (uno por obra) y la ficha lo trae con su URL, triángulos, vértices y caja.

Como la imagen, el modelo solo cambia en borrador o en un proyecto propio: una obra auditada no cambia de modelo sin volver a auditarse. Los triángulos son evidencia para la auditoría, nunca precio.

## Imágenes

El navegador sube la imagen **directo al bucket** con la URL prefirmada; el backend nunca recibe el archivo. Las imágenes se leen desde la base pública `MEDIA_PUBLIC_BASE_URL`. En local el almacenamiento es Garage (S3-compatible, ver ADR 0007); en producción sirve cualquier S3 o la interoperabilidad S3 de Cloud Storage sin cambiar código.

El Content-Type queda firmado: un `PUT` con otro tipo (por ejemplo `text/html`) se rechaza con 403, así nadie puede subir una página que el endpoint web serviría como HTML.

## Traducción de fichas

Las fichas públicas se muestran en español o en inglés aunque el autor escriba en uno solo. catalog guarda la traducción; quien traduce es ai-service con Opus-MT, un modelo abierto que corre en local (ver su README).

- **Reconciliador.** Cada `TRANSLATION_INTERVAL_MS` el worker encola las fichas públicas cuya versión actual no tiene traducción ni solicitud. La versión se reconoce por una huella: SHA-256 de título, descripción, materiales y procedencia separados por `chr(31)`, calculada igual en SQL y en TypeScript. Así entran por un solo camino las obras que se publican, las que se editan y las que ya existían.
- **Cola.** `catalog.translation_requests` se reclama con `FOR UPDATE SKIP LOCKED` y un arriendo de 5 minutos. Se traducen `TRANSLATION_BATCH` fichas por pasada, de a una, porque el modelo usa la CPU de ai-service. Un fallo se reintenta con espera doble (30 s, 1 min… hasta 30 min); al quinto queda `FALLIDA`.
- **Descarte.** Si al traducir la ficha ya cambió, dejó de ser pública o se borró, la solicitud se borra: la siguiente pasada encola la versión nueva.
- **Lectura.** `catalog.lot_translations` guarda una fila por idioma con la huella del texto que tradujo. La obra solo lleva las traducciones de su huella vigente, así nunca se muestra la traducción de un texto viejo. El gateway elige el idioma según `Accept-Language` y devuelve el original aparte (`translated`, `original`).
- **Búsqueda.** El buscador público también mira las traducciones: "statue" encuentra una obra escrita en español.

Con `TRANSLATION_ENABLED=false` (así va en CI) no se traduce nada y las fichas se ven en su idioma original.

## Estructura

```
src/
  api/grpc/            CatalogService y CatalogEventHandlerService, mapeo proto <-> dominio
  api/events/          rutas del outbox: evento de dominio -> mensaje protobuf -> consumidor
  internal/
    domain/            Lot, máquina de estados, alta de obra, URL de imagen, eventos
    application/       consultas, comandos, handlers de eventos y puertos
    infrastructure/    Prisma (esquema catalog y cola de traducción), firmador S3, pool de hash y su worker
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

`npm test -w @artauction/catalog-service`: máquina de estados, alta de obra, URLs de imagen, visibilidad, roles, propiedad de claves, revisión manual con su evento, idempotencia de eventos entrantes y el worker de traducción (huella, descarte, reintentos).
