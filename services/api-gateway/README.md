# api-gateway

Backend for Frontend de ArtAuction AI. Ocupa `http://localhost:3001`, el mismo puerto y el mismo contrato REST y Socket.IO que usaba el monolito, así el frontend no cambia.

No contiene reglas de negocio. Hace cuatro cosas:

1. **Valida la forma** de cada petición (class-validator, mismas reglas que el monolito).
2. **Traduce REST a gRPC** hacia el servicio dueño y reenvía el access token en la metadata `authorization`; el servicio lo verifica (zero trust).
3. **Traduce errores gRPC a HTTP** con la misma forma JSON del monolito: `{ statusCode, error, message }`. Un error inesperado sale como 500 sin detalles.
4. **Reenvía al monolito** lo que todavía no se ha migrado (Strangler Fig), incluido el upgrade de WebSocket de Socket.IO.

## Rutas

| Ruta | Destino |
|---|---|
| `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `GET/PATCH /auth/me` | identity-service por gRPC |
| `GET /health` | el propio gateway |
| todo lo demás | monolito en `LEGACY_URL` |

La lista de prefijos migrados está en `src/api/http/legacy-proxy.ts` (`MIGRATED_PREFIXES`). Cada fase de la migración agrega los suyos; cuando cubran todo, el proxy se retira.

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

Necesita identity-service en `IDENTITY_GRPC_URL` y, mientras dure la migración, el monolito en `LEGACY_URL`.

## Pruebas

`npm test -w @artauction/api-gateway` levanta un identity gRPC falso y un monolito HTTP falso y comprueba la forma de las respuestas, la traducción de errores, la validación, el reenvío del token y el proxy con cuerpo intacto y `X-Forwarded-For`.
