# api-gateway

Backend for Frontend de ArtAuction AI. Ocupa `http://localhost:3001`, el mismo puerto y el mismo contrato REST y Socket.IO que usaba el monolito, así el frontend no cambia.

No contiene reglas de negocio. Hace cinco cosas:

1. **Valida la forma** de cada petición (class-validator, mismas reglas que el monolito).
2. **Traduce REST a gRPC** hacia el servicio dueño y reenvía el access token en la metadata `authorization`; el servicio lo verifica (zero trust).
3. **Traduce errores gRPC a HTTP** con la misma forma JSON del monolito: `{ statusCode, error, message }`. Un error inesperado sale como 500 sin detalles.
4. **Sirve la sala en vivo** por Socket.IO sobre los streams `WatchAuction` de auction-service.
5. **Reenvía al monolito** lo que todavía no se ha migrado (Strangler Fig). Desde F6 ya no reenvía WebSocket.

## Rutas

| Ruta | Destino |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `GET/PATCH /auth/me` | identity-service por gRPC |
| `GET /lots`, `GET /lots/categories`, `GET /lots/:id`, `GET /lots/:id/related` | catalog-service, compuesto con el resumen de subasta y el último informe de auditoría |
| `POST /lots`, `/lots/:id/hash`, `/lots/:id/uploads`, `/lots/:id/images`, `/lots/:id/submit` | catalog-service |
| `POST /admin/lots/:id/resolve` | catalog-service (el rol ADMIN lo comprueba el servicio) |
| `GET /wallet`, `POST /wallet/top-ups` | wallet-service. La recarga exige la cabecera `Idempotency-Key` (400 sin ella); 20 por minuto |
| `GET /auctions/:id`, `POST /auctions`, `POST /auctions/:id/bids`, `POST /auctions/:id/withdraw` | auction-service. Las pujas no exponen su clave de idempotencia; 30 pujas por minuto |
| `GET /health` | el propio gateway |
| todo lo demás | monolito en `LEGACY_URL` |

**Composición con degradación.** Las tarjetas y la ficha combinan el catálogo con `AuctionService.BatchGetAuctionSummaries` y `AuditService.BatchGetLatestSummaries`. Si alguno no responde, la obra sale con `auction: null` o `auditSummaries: []` en lugar de fallar: el catálogo no se cae por un servicio vecino.

La lista de prefijos migrados está en `src/api/http/legacy-proxy.ts` (`MIGRATED_PREFIXES`). Cada fase de la migración agrega los suyos; cuando cubran todo, el proxy se retira.

## Sala en vivo (Socket.IO)

Mismo contrato que el monolito (`artauction_frontend/src/lib/ws/events.ts`):

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

- **Sin body parser global.** El cuerpo de las rutas reenviadas pasa intacto al monolito; solo las rutas migradas se parsean (límite 1 MB).
- **`X-Forwarded-For`.** El proxy añade la IP del cliente y el monolito confía solo en un proxy local (`trust proxy = loopback`), para que su rate limit no meta a todos los usuarios en el mismo cupo.
- **Rate limit propio.** 120 peticiones por minuto en general, 10 en `/auth/login` y 30 en `/auth/refresh`.
- **Un canal HTTP/2 persistente por servicio** con keepalive; grpc-js multiplexa las llamadas. Cada llamada lleva deadline (`GRPC_DEADLINE_MS`) y correlation id.
- **CORS** limitado a `CORS_ORIGINS`. En las respuestas proxificadas queda una sola cabecera `Access-Control-Allow-Origin`.

## Ejecutar

```bash
cp .env.example .env
npm run build -w @artauction/api-gateway
npm start -w @artauction/api-gateway
```

Necesita identity-service en `IDENTITY_GRPC_URL`, auction-service en `AUCTION_GRPC_URL` para la sala en vivo y, mientras dure la migración, el monolito en `LEGACY_URL`.

## Pruebas

`npm test -w @artauction/api-gateway` levanta servicios gRPC falsos (identity, auction) y un monolito HTTP falso. Comprueba la forma de las respuestas (incluida la sala sin claves de idempotencia), la traducción de errores, la validación, el reenvío del token y el proxy con cuerpo intacto y `X-Forwarded-For`. También prueba el conteo de referencias y la reconexión de `RoomStreams` con timers falsos.
