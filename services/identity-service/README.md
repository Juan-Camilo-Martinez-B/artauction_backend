# identity-service

Cuentas, sesiones y emisión de tokens de ArtAuction AI. Es el único servicio que tiene la **clave privada RS256**: todos los demás, y el gateway, solo verifican con la clave pública.

Expone `artauction.identity.v1.IdentityService` por gRPC (puerto `50051`) y `grpc.health.v1`. No tiene HTTP: el frontend llega a través del api-gateway (`/auth/*`).

## Qué resuelve

| RPC | Caso de uso | Notas |
|---|---|---|
| `Register` | `RegisterAccount` | Normaliza el correo, exige 10+ caracteres y solo deja elegir `USER` o `SELLER`. Argon2id. |
| `Login` | `Login` | Si el correo no existe verifica contra un hash señuelo: la respuesta tarda lo mismo y no revela qué correos existen. |
| `RefreshSession` | `RotateRefreshSession` | Refresh opaco de 256 bits; en Postgres solo vive su SHA-256. Cada uso rota la sesión. Reusar una sesión revocada revoca toda la familia. Dos rotaciones simultáneas del mismo token: solo una gana. |
| `GetAccount`, `UpdateProfile` | `GetAccount`, `UpdateProfile` | El usuario sale del access token en la metadata `authorization`. El avatar tiene que ser `https` sin credenciales. |
| `GetPublicProfile` | `GetPublicProfile` | Oculta el avatar de un perfil privado. |
| `GetSigningKeys` | `GetSigningKeys` | Clave pública con `kid` (huella SHA-256), para rotar claves sin cortar el servicio. |
| `IssueServiceToken` | `IssueServiceToken` | OAuth2 client credentials entre servicios. Los secretos se comparan en tiempo constante contra huellas de `SERVICE_CLIENTS`. |

Los tokens llevan `iss=artauction-identity`, `aud=artauction` y `typ` (`access` o `service`). `@artauction/platform` (`TokenVerifier`) solo acepta RS256 con ese emisor y esa audiencia: un token HS256 o `alg=none` se rechaza.

## Estructura

```
src/
  api/grpc/              frontera: mapeo proto <-> casos de uso y resolución del usuario
  internal/
    domain/              Account y reglas (correo, contraseña, rol, avatar), RefreshSession
    application/         casos de uso, puertos y SessionIssuer
    infrastructure/      Prisma (esquema identity), refresh_sessions, argon2, RS256
  identity.module.ts     raíz de composición: une puertos con implementaciones
  config.ts              variables de entorno validadas
  main.ts                arranque del servidor gRPC
prisma/schema.prisma     solo la tabla identity.users; el DDL vive en artauction_bd
```

`internal` no importa `api`, contratos gRPC ni frameworks en el dominio; el lint de la raíz lo verifica.

## Datos

- Postgres: esquema `identity` (`users` y `refresh_sessions`), usuario `identity_svc` (creado con `npm run roles` en `artauction_bd`), sin permisos sobre otros esquemas.
- Sesiones vencidas: `PurgeExpiredSessions` las borra un día después de vencer, cada `SESSION_SWEEP_MS` (una hora por defecto). Hasta F10 lo hacía un índice TTL de Mongo; una sesión vencida ya no rota, así que borrarla no cambia ninguna respuesta.

Las sesiones de refresh que emitió el monolito vivían en la base `artauction`; al pasar a este servicio, quien tenga una sesión abierta vuelve a iniciar sesión una vez.

## Ejecutar

```bash
# En la raíz del monorepo, una vez:
node scripts/generate-keys.mjs
# En artauction_bd, con IDENTITY_DB_PASSWORD definido:
npm run roles

cp .env.example .env          # completar DATABASE_URL y SERVICE_CLIENTS
npm run build -w @artauction/identity-service
npm start -w @artauction/identity-service
```

## Pruebas

`npm test -w @artauction/identity-service`: casos de uso con dobles en memoria (registro, señuelo, rotación, reuso, carrera de rotación, avatar, tokens de servicio y barrido de sesiones vencidas con su límite).
