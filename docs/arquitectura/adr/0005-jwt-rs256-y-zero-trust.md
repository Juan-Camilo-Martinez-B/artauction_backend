# ADR 0005: JWT RS256 y verificacion en cada servicio

Estado: aceptado.

## Contexto

En el monolito el access token se firma con un secreto HMAC compartido. Con varios servicios, compartir ese secreto permitiria a cualquiera emitir tokens.

## Decision

- `identity-service` es el unico que tiene la clave privada RS256 y firma los access tokens. El refresh sigue siendo opaco, rotativo y con deteccion de reuso por familia.
- Los demas servicios y el gateway solo tienen la clave publica.
- El gateway reenvia el access token en la metadata gRPC `authorization`. Cada servicio lo verifica antes de ejecutar un caso de uso que requiere identidad (zero trust).
- Los eventos internos entre servicios viajan con un token de servicio de corta duracion firmado por identity para el emisor.
- TLS en gRPC se activa con `GRPC_TLS=true` y rutas a certificados. En local va sin TLS.
- Las claves se generan con `scripts/generate-keys.mjs` en `secrets/`, que no se versiona.

## Consecuencias

- Rotar la clave implica redistribuir la publica; se publica con un `kid`.
- El frontend no cambia: sigue recibiendo un access token y un refresh token.
