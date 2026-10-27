# @artauction/contracts

Contratos gRPC de ArtAuction AI. Son el único código que comparten los microservicios: describen qué se puede pedir a cada servicio y qué eventos publica. No contienen reglas de negocio.

## Organización

```
proto/artauction/
  common/v1                 metadatos de evento, paginación, visibilidad
  identity/v1               IdentityService
  catalog/v1                CatalogService y CatalogEventHandlerService
  catalog/events/v1         LotCreated, LotSubmitted, LotPublished
  auction/v1                AuctionService (con stream WatchAuction) y AuctionEventHandlerService
  auction/events/v1         AuctionStarted, BidAccepted, BidWithdrawn, AuctionClosed, AuctionRescheduled
  wallet/v1                 WalletService y WalletEventHandlerService
  audit/v1                  AuditService y AuditEventHandlerService
  audit/events/v1           AuditCompleted
  ai/v1                     AiService
  gallery/v1                GalleryService y GalleryEventHandlerService
  notification/v1           NotificationService y NotificationEventHandlerService
```

Los eventos viven en un paquete `events` propio de cada productor que solo depende de `common`. Así ningún paquete de servicio depende de otro paquete de servicio y no hay ciclos (`buf lint` lo verifica).

## Convenciones

- **Versionado por paquete.** Un cambio incompatible crea `v2`; `npm run breaking` compara con `main`.
- **Dinero en texto decimal** con dos cifras (`"120.00"`), nunca `double`. Las artacoins son enteros.
- **Conjuntos cerrados como `enum`** con valor cero `*_UNSPECIFIED`. El gateway traduce a los textos que espera el frontend.
- **Identidad en la metadata, no en el mensaje.** El usuario sale del access token en `authorization`; las RPC internas exigen un token de servicio.
- **Eventos idempotentes.** Todo evento lleva `common.v1.EventMetadata.event_id`; los consumidores lo registran en su inbox.
- **Entrega de eventos.** Cada consumidor expone `*EventHandlerService` con un `Handle<Evento>` por evento; el outbox del productor los llama.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run lint:proto` | `buf lint` con las reglas STANDARD |
| `npm run breaking` | Detecta cambios incompatibles contra `main` |
| `npm run generate` | Genera `src/generated` con ts-proto (no se versiona) |
| `npm run build` | Genera y compila a `dist` |
| `npm test` | Pruebas de serialización en el cable |

El plugin se invoca con `node` y no con el shim `.cmd` de npm, porque en Windows ese shim corrompe la salida binaria del plugin.

## Uso

```ts
import { auctionV1 } from '@artauction/contracts';

const request = auctionV1.PlaceBidRequest.fromPartial({ auctionId, amount: '120.00', idempotencyKey });
```

Solo la capa `api` de un servicio importa este paquete. La capa `internal` trabaja con sus propios tipos y la regla de lint lo impide.
