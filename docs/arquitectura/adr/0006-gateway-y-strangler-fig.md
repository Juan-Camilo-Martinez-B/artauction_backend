# ADR 0006: API gateway y migracion Strangler Fig

Estado: aceptado.

## Contexto

El frontend consume REST y Socket.IO en `:3001`. La migracion es por fases y la aplicacion debe funcionar al cerrar cada una.

## Decision

- `api-gateway` (BFF) ocupa `:3001` y mantiene el contrato REST y Socket.IO actual. Valida entrada, aplica rate limit y CORS, traduce a gRPC y compone lecturas que combinan varios servicios (API composition).
- Durante la migracion, las rutas que aun no tienen servicio se reenvian al monolito, que pasa a escuchar en otro puerto. Cada fase mueve un grupo de rutas al nuevo servicio.
- Al final se retira el monolito.

## Consecuencias

- El gateway no contiene reglas de negocio; solo enruta, valida forma y compone.
- Hay un salto de red adicional por peticion, mitigado por gRPC sobre HTTP/2 y conexiones persistentes.

## Resultado

La ultima ruta reenviada fue `/docs`. En F9 el gateway paso a generar su propio OpenAPI (`/docs` y `/docs-json`) y se retiraron el proxy (`legacy-proxy.ts`, `LEGACY_URL`) y el monolito. Desde entonces, una ruta sin servicio responde 404.
