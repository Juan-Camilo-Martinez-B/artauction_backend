# @artauction/service-kit

Piezas comunes de la **capa api** de los microservicios. A diferencia de `@artauction/platform`, este paquete sí conoce gRPC y los contratos, por eso la capa `internal` tiene prohibido importarlo (regla de lint).

| Pieza | Para qué |
|---|---|
| `startGrpcServer` | Servidor gRPC con `grpc.health.v1`, límites de mensaje y cierre ordenado (marca `NOT_SERVING` antes de drenar). |
| `unary` | Adapta un caso de uso asíncrono a la firma de grpc-js: propaga el correlation id, traduce `DomainError` a status gRPC y registra solo los errores inesperados, sin enviar su detalle al cliente. |
| `invoke` | Llama a un método unario de un cliente generado como promesa, siempre con deadline, correlation id y, si se pasa, `authorization`. |
| `ServiceTokenProvider` | Obtiene y cachea el token de servicio de identity (client credentials); las peticiones concurrentes comparten una sola solicitud. |

Pruebas: `npm test -w @artauction/service-kit` levanta un servidor real en un puerto efímero.
