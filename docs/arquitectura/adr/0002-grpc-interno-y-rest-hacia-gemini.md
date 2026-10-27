# ADR 0002: gRPC sobre HTTP/2 entre servicios y REST hacia Gemini

Estado: aceptado.

## Contexto

Se busca baja latencia entre servicios y contratos tipados. Para APIs externas se usa gRPC si el proveedor lo admite y REST si no.

## Decision

- Toda llamada entre servicios usa gRPC sobre HTTP/2 con `@grpc/grpc-js`. Los contratos son `.proto` versionados por paquete (`artauction.<servicio>.v1`) en `packages/contracts`, con lint de buf y codigo TS generado con ts-proto.
- HTTP/2 multiplexa llamadas en una conexion y permite streams. El tiempo real de la sala usa un stream de servidor (`WatchAuction`).
- Gemini se consume por REST. La interfaz oficial de la Gemini API es REST con la cabecera `x-goog-api-key` (o el SDK `@google/genai`, que tambien usa REST). gRPC con API key contra `generativelanguage.googleapis.com` no esta documentado y hay reportes de conexiones fallidas.
- La llamada a Gemini vive solo en `ai-service`, que la expone por gRPC a los demas.

## Consecuencias

- El frontend no habla gRPC: el gateway traduce REST y Socket.IO a gRPC.
- Cada cambio incompatible en un `.proto` exige una version nueva del paquete; buf lo detecta.
