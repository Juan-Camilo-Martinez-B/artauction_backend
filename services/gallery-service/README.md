# gallery-service

Galería 3D personal y galería social de ArtAuction AI. Es el dueño del esquema `gallery` (`personal_galleries`, `personal_gallery_artworks`, `follows`, `inbox`) y de la base Mongo `artauction_gallery` (`gallery_items`, `activity_feed`). Expone `artauction.gallery.v1.GalleryService` y `GalleryEventHandlerService` por gRPC (puerto `50057`).

## Galería 3D personal

Cada usuario tiene una sala, que se crea en su primer acceso.

| Operación | Regla |
|---|---|
| Preferencias y diseño | Las preferencias del cuestionario se validan con `parsePreferences`. El diseño lo pide a ai-service; si no hay modelo, no responde o propone algo inválido, usa el diseño local (`designFromPreferences`). El usuario siempre obtiene una sala válida |
| Cambios manuales | Editar la sala la deja `EDITADA`. Generar una nueva sobre cambios manuales pide confirmación (`409`) |
| Colgar una obra | Solo obras públicas de catalog (`BatchGetPublicLots`). Una pintura va a la pared del fondo en filas de tres; una escultura, sobre pedestal. Repetirla no la duplica |
| Mover una obra | Soporte entre `WALL`, `PEDESTAL`, `FLOOR`, `PLATFORM` y `NICHE`; escala mayor que 0 y hasta 3 |

La sala guarda solo posiciones y el `lotId`. La ficha de cada obra la compone el api-gateway con catalog (ADR 0006). Si una obra dejó de ser pública, por ejemplo porque se vendió, no se muestra, aunque su posición queda guardada.

### Diseño con IA y esquema de la sala

El esquema de la configuración (`GalleryConfig`, versión 1) es de este servicio. Al pedir un diseño se envía a ai-service el JSON Schema equivalente (`GALLERY_CONFIG_JSON_SCHEMA`), que Gemini usa como `responseJsonSchema`. La respuesta pasa además por `validateGalleryConfig`. Una prueba comprueba que el diseño local cumple los mismos campos obligatorios, así esquema y validador no se separan.

## Galería social

- **Obras propias:** `LotCreated` de catalog agrega la obra a la galería del vendedor, privada.
- **Obras ganadas:** `AuctionClosed` de auction agrega la obra al ganador, con la ficha interna de catalog (`BatchGetLotSnapshots`), y publica la actividad `WIN`.
- **Seguir:** comprueba que el usuario exista con `GetPublicProfile` de identity y publica la actividad `FOLLOW`. Nadie se sigue a sí mismo y repetir no duplica.
- **Feed:** las últimas 50 actividades públicas y las propias.
- **Visibilidad:** una obra privada solo la ve su dueño.

### Eventos sin duplicados

El inbox está en Postgres y los efectos en Mongo, así que no comparten transacción. Por eso los documentos tienen **ids deterministas**:

- obra: `PROPIA:<lot>:<dueño>` o `GANADA:<lot>:<ganador>`;
- actividad: `win:<evento>` y `follow:<seguidor>:<seguido>`.

Las escrituras son `upsert` con `$setOnInsert`. Si el proceso cae entre el efecto y el registro en el inbox, el reintento reescribe el mismo documento. Los documentos migrados del monolito conservan su `ObjectId`.

## Estructura

```
src/
  api/grpc/          GalleryService y GalleryEventHandlerService
  api/clients/       catalog (fichas), identity (usuario) y ai-service (diseño con respaldo local)
  internal/
    domain/          gallery-design (esquema 1, preferencias, diseño local, JSON Schema) y reglas de la sala
    application/     PersonalGalleryUseCases, SocialUseCases, GalleryEventHandlers y puertos
    infrastructure/  Prisma (esquema gallery) y Mongo (artauction_gallery)
  gallery.module.ts  raíz de composición
```

## Ejecutar

```bash
cp .env.example .env     # completar DATABASE_URL (usuario gallery_svc) y SERVICE_CLIENT_SECRET
npm run build -w @artauction/gallery-service
npm start -w @artauction/gallery-service
```

## Pruebas

`npm test -w @artauction/gallery-service`:

- colocación inicial de pinturas y esculturas, y validación de soporte y escala;
- sala nueva, obras públicas sin duplicar, conflicto ante cambios manuales y configuración inválida;
- seguir una sola vez, seguirse a sí mismo y usuario inexistente;
- eventos repetidos sin duplicados, visibilidad de lo privado y feed de victorias;
- el diseño local cumple el JSON Schema enviado a ai-service.
