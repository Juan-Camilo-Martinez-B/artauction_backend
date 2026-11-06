# gallery-service

Galería 3D personal y galería social de ArtAuction AI. Es el dueño del esquema `gallery` (`personal_galleries`, `personal_gallery_artworks`, `follows`, `items`, `activity`, `inbox`). Expone `artauction.gallery.v1.GalleryService` y `GalleryEventHandlerService` por gRPC (puerto `50057`).

## Galería 3D personal

Cada usuario tiene una sala, que se crea en su primer acceso.

| Operación | Regla |
|---|---|
| Preferencias y diseño | Las preferencias del cuestionario se validan con `parsePreferences`. El diseño lo pide a ai-service; si no hay modelo, no responde o propone algo inválido, usa el diseño local (`designFromPreferences`). El usuario siempre obtiene una sala válida. Los textos de la sala (nombre de estilo, resumen y clima de luz) salen en el idioma de quien la genera (`locale` de `GenerateGallery`, `es` o `en`): se lo pide al modelo y el diseño local los toma de `gallery-labels`, con un texto por idioma para cada identificador |
| Cambios manuales | Editar la sala la deja `EDITADA`. Generar una nueva sobre cambios manuales pide confirmación (`409`) |
| Colgar una obra | Solo lo propio: la obra tiene que estar en la galería de quien la cuelga (`PROYECTO`, `PROPIA` o `GANADA`); si no, `403`. Un proyecto propio y una obra ganada se cuelgan solos al llegar. Una pintura va al primer hueco libre de 2 m, recorriendo el fondo, la izquierda, la derecha y la entrada; una escultura, al primer punto libre de una retícula de pedestales en el centro. Un hueco ocupado por una obra movida a mano se respeta. Repetirla no la duplica. Un objeto sin modelo 3D no se cuelga (`canExhibit`): si llega por evento se omite y a mano responde `409`. El botón **Organizar** de la sala reparte todo según las medidas reales |
| Mover una obra | Soporte entre `WALL`, `PEDESTAL`, `FLOOR`, `PLATFORM` y `NICHE`; escala mayor que 0 y hasta 3 |

La sala guarda solo posiciones y el `lotId`. Al devolverla, este servicio agrega la ficha interna de cada obra colgada (`BatchGetLotSnapshots`, con su token de servicio), porque todo lo colgado es de su dueña aunque sea privado o ya vendido. El gateway la muestra sin necesitar permisos internos. Si catalog no responde, la sala sale sin fichas y esas obras no se muestran.

### Diseño con IA y esquema de la sala

El esquema de la configuración (`GalleryConfig`, versión 1) es de este servicio. Al pedir un diseño se envía a ai-service el JSON Schema equivalente (`GALLERY_CONFIG_JSON_SCHEMA`), que el modelo de IA usa como esquema de salida en modo estricto (ai-service lo adapta a lo que exige Groq). La respuesta pasa además por `validateGalleryConfig`. Una prueba comprueba que el diseño local cumple los mismos campos obligatorios, así esquema y validador no se separan.

## Galería social

La galería registra **lo que es de cada persona** (`gallery.items`, una entrada por obra y dueña):

| Origen | Qué es | Llega con |
|---|---|---|
| `PROYECTO` | Proyecto propio del autor, sin auditar. Público o privado según elija | `LotCreated` con `personal`; `LotVisibilityChanged` cambia su visibilidad |
| `PROPIA` | Obra del autor en el catálogo, aún sin vender | `LotCreated`; o `LotSubmitted`, cuando un proyecto pasa al catálogo |
| `GANADA` | Obra ganada en subasta | `AuctionClosed` |

- **Venta:** `AuctionClosed` con ganador traspasa la obra. Sale de la galería y de la sala del autor, entra en las del ganador (con la ficha interna de catalog), se cuelga sola y se publica la actividad `WIN`.
- **Ficha guardada:** al venderse, el catálogo deja la obra privada y su ficha original ya no se abre. La galería del ganador guarda una copia fija (`gallery.items.sheet`): el mensaje `catalog.v1.Lot` en base64, el precio pagado, la fecha y si fue por compra inmediata. `GetPurchasedSheet` la entrega con la visibilidad de la obra en la galería; el precio solo lo ve la dueña. Una compra anterior a la ficha guardada la recibe la primera vez que se abre, pedida al catálogo y sin precio.
- **Proyecto propio:** se cuelga solo en la sala del autor. Si es público, aparece en su galería pública; el frontend lo marca como «Proyecto propio, sin auditar».
- **Seguir:** comprueba que el usuario exista con `GetPublicProfile` de identity y publica la actividad `FOLLOW`. Nadie se sigue a sí mismo y repetir no duplica.
- **Feed:** las últimas 50 actividades públicas y las propias.
- **Visibilidad:** una obra privada solo la ve su dueño.

### Explorar galerías

`ListPublicGalleries` lista a quienes tienen obras públicas, con su número de obras, sus seguidores y una muestra de cuatro. Se puede ordenar por lo más reciente o por seguidores. El gateway añade el nombre desde identity y descarta los perfiles privados, así que una página puede traer menos tarjetas que su tamaño.

Una obra aparece en la galería pública cuando entra al catálogo (evento `LotListed`, por auditoría o por un administrador) o cuando su autor hace público un proyecto propio. Una obra en auditoría o una obra ganada siguen siendo privadas.

La imagen de la muestra se pide a catalog la primera vez y se guarda en `preview_url`; si catalog no responde, la obra sale sin imagen y se reintenta en la siguiente visita. `UnfollowUser` borra también la actividad del seguimiento, y `ListFollowing` dice a quién sigue la sesión.

### Eventos sin duplicados

El inbox y los efectos están en el mismo esquema, pero los escriben puertos distintos y no comparten transacción. Por eso las filas tienen **ids deterministas**:

- obra: `PROPIA:<lot>:<autor>` (también para un `PROYECTO`, así pasar al catálogo no crea otra fila) o `GANADA:<lot>:<ganador>`;
- actividad: `win:<evento>` y `follow:<seguidor>:<seguido>`.

Las escrituras son `INSERT ... ON CONFLICT DO NOTHING`. Si el proceso cae entre el efecto y el registro en el inbox, el reintento choca con la misma fila y no la duplica.

## Estructura

```
src/
  api/grpc/          GalleryService y GalleryEventHandlerService
  api/clients/       catalog (fichas), identity (usuario) y ai-service (diseño con respaldo local)
  internal/
    domain/          gallery-design (esquema 1, preferencias, diseño local, JSON Schema), gallery-labels (textos de la sala por idioma) y reglas de la sala
    application/     PersonalGalleryUseCases, SocialUseCases, GalleryEventHandlers y puertos
    infrastructure/  Prisma (esquema gallery)
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

- colocación inicial en el primer hueco libre (pared del fondo llena, hueco liberado, retícula de pedestales) y validación de soporte y escala;
- sala nueva, solo obras propias y sin duplicar, conflicto ante cambios manuales y configuración inválida;
- traspaso al vender (el autor pierde la obra y su colocación, el ganador la recibe colgada), proyecto propio con su visibilidad y colgado solo, y paso al catálogo;
- seguir una sola vez, seguirse a sí mismo y usuario inexistente;
- eventos repetidos sin duplicados, visibilidad de lo privado y feed de victorias;
- el diseño local cumple el JSON Schema enviado a ai-service.
