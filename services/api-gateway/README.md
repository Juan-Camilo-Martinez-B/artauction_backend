# api-gateway

Backend for Frontend de ArtAuction AI. Es la única puerta HTTP de la plataforma: el frontend habla con `http://localhost:3001` por REST y Socket.IO, y el gateway habla con los servicios por gRPC sobre HTTP/2. Conserva el contrato que tenía el monolito, así que el frontend no cambió con la migración.

No contiene reglas de negocio. Hace cinco cosas:

1. **Valida la forma** de cada petición con class-validator, antes de gastar una llamada gRPC.
2. **Traduce REST a gRPC** hacia el servicio dueño y reenvía el access token en la metadata `authorization`. El servicio lo verifica por su cuenta (zero trust): el gateway no es una frontera de confianza.
3. **Traduce errores a HTTP** con una sola forma JSON, `{ statusCode, error, message }`. Los códigos gRPC se mapean a su estado HTTP, los errores de cuerpo (JSON mal formado, cuerpo demasiado grande) salen como 400 o 413, y un error inesperado sale como 500 sin detalles.
4. **Compone lecturas** de varios servicios, con degradación cuando un vecino no responde.
5. **Sirve la sala en vivo** por Socket.IO sobre los streams `WatchAuction` de auction-service.

## Rutas

| Ruta | Destino |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `GET/PATCH /auth/me` | identity-service |
| `GET /lots`, `GET /lots/categories`, `GET /lots/:id`, `GET /lots/:id/related` | catalog-service, compuesto con el resumen de subasta y el último informe de auditoría |
| `POST /lots`, `/lots/:id/hash`, `/lots/:id/uploads`, `/lots/:id/images`, `/lots/:id/submit` | catalog-service |
| `GET /admin/reviews` | cola de revisión manual: `ListReviewQueue` de catalog compuesto con `BatchGetReviewReports` de audit (hallazgos con el valor de sus evidencias). Si audit no responde, cada obra sale con `audit: null`. Solo ADMIN |
| `POST /admin/lots/:id/resolve` | catalog-service (el rol ADMIN lo comprueba el servicio) |
| `GET /wallet`, `POST /wallet/top-ups` | wallet-service. La recarga exige la cabecera `Idempotency-Key` (400 sin ella); 20 por minuto |
| `GET /auctions/:id`, `POST /auctions`, `POST /auctions/:id/bids`, `POST /auctions/:id/withdraw` | auction-service. Las pujas no exponen su clave de idempotencia; 30 pujas por minuto |
| `/me/gallery/*` | gallery-service. El gateway completa cada obra colgada con su ficha pública de catalog; una obra que dejó de ser pública no se muestra |
| `GET /galleries/:ownerId`, `POST /users/:id/follow`, `GET /feed` | gallery-service |
| `GET /notifications` | notification-service. Repone como `null` los valores nulos que un `map` de proto no transporta |
| `GET /health` | el propio gateway |
| `GET /docs`, `GET /docs-json` | contrato OpenAPI generado de los controladores (`@nestjs/swagger`) |

Cualquier otra ruta responde 404.

**Composición con degradación.** Las tarjetas y la ficha combinan el catálogo con `AuctionService.BatchGetAuctionSummaries` y `AuditService.BatchGetLatestSummaries`. Si alguno no responde, la obra sale con `auction: null` o `auditSummaries: []` en lugar de fallar: el catálogo no se cae por un servicio vecino.

## OpenAPI

`/docs` sirve Swagger UI y `/docs-json` el documento OpenAPI 3, generado de los DTO y controladores que validan cada petición. Así el contrato no se separa del código. Los endpoints protegidos declaran el esquema `bearer`. El resumen escrito de las rutas está en [`docs/openapi/v1.md`](../../docs/openapi/v1.md).

## Sala en vivo (Socket.IO)

Contrato que consume el frontend (`artauction_frontend/src/lib/ws/events.ts`):

| Dirección | Evento | Contenido |
|---|---|---|
| cliente → gateway | `auction:join` | id de la subasta; responde `{ serverTime }` y emite `serverTime` |
| cliente → gateway | `bid:place` | `{ auctionId, amount, idempotencyKey }`; responde `{ ok, bidId }` o el rechazo |
| gateway → sala | `bid:accepted` | `{ version: 1, auctionId, bidId, bidderId, amount, endsAt, extended, serverTime }` |
| gateway → socket | `bid:rejected` | `{ version: 1, auctionId, message, serverTime }` |
| gateway → sala | `auction:closed` | `{ version: 1, auctionId, lotId, winnerId, amount, serverTime }` |

- **Autenticación en el handshake.** `auth.token` se verifica con la clave pública RS256 de identity (`JWT_PUBLIC_KEY_PATH`); sin token válido la conexión se rechaza. Sin clave configurada la sala queda desactivada.
- **Un stream por sala.** `RoomStreams` abre un solo `WatchAuction` por sala con espectadores, con conteo de referencias. Lo cierra al salir el último y lo reabre con backoff exponencial (1 s a 15 s) si se corta. Los avisos de un corte se pierden; el frontend recupera el estado con `GET /auctions/:id`.
- **Pujas con el token del usuario.** `bid:place` llama a `PlaceBid` con el token del handshake, así auction-service decide quién puja. Ese token caduca antes que la sesión. Como el frontend envía cada puja también por REST, con un token renovado y la misma clave, un token de socket vencido no anuncia `bid:rejected` y la puja entra por REST una sola vez.
- **Límites por socket.** 10 salas a la vez, 20 pujas cada 10 s y mensajes de 16 KB como máximo.
- **Una instancia de auction-service.** Los avisos salen de memoria en auction-service (ver su README).

## Decisiones

- **Límite de cuerpo por ruta.** `/lots` acepta hasta 12 MB, porque `POST /lots/:id/hash` recibe la imagen en base64 para calcular el hash perceptual. El resto, 1 MB. Las imágenes en sí no pasan por el gateway: el navegador las sube directo al bucket con una URL prefirmada.
- **Rate limit propio.** 120 peticiones por minuto en general, 10 en `/auth/login` y 30 en `/auth/refresh`.
- **Un canal HTTP/2 persistente por servicio** con keepalive; grpc-js multiplexa las llamadas. Cada llamada lleva deadline (`GRPC_DEADLINE_MS`) y correlation id.
- **CORS** limitado a `CORS_ORIGINS`.

## Ejecutar

Con toda la plataforma, desde la raíz del monorepo: `npm run compose:up` (ver el README principal). Para desarrollarlo solo:

```bash
cp .env.example .env
npm run build -w @artauction/api-gateway
npm start -w @artauction/api-gateway
```

Necesita los servicios en las URL `*_GRPC_URL` del `.env`. Sin un servicio, sus rutas responden 503 y las lecturas compuestas se degradan; el resto sigue funcionando.

## Pruebas

`npm test -w @artauction/api-gateway` levanta servicios gRPC falsos (identity, auction) en memoria. Comprueba:

- la forma de las respuestas, incluida la sala sin claves de idempotencia;
- la traducción de errores, la validación y el reenvío del token;
- el 404 de rutas desconocidas;
- que `/docs-json` publique las rutas del frontend;
- los límites de cuerpo (413) y el JSON mal formado (400);
- el conteo de referencias y la reconexión de `RoomStreams`, con timers falsos.

La prueba de punta a punta contra la plataforma real está en [`e2e/`](../../e2e).
