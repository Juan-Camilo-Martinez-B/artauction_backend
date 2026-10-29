# notification-service

Avisos de ArtAuction AI. Es el dueño de la base Mongo `artauction_notification` (`notifications` y su inbox `processed_events`). Expone `artauction.notification.v1.NotificationService` y `NotificationEventHandlerService` por gRPC (puerto `50058`). No llama a otros servicios.

| Evento | Productor | Quién recibe el aviso |
|---|---|---|
| `AuditCompleted` | audit-service | El vendedor (`AUDIT`, con el veredicto) |
| `AuctionClosed` | auction-service | El vendedor y, si lo hay, el ganador (`AUCTION_CLOSED`, con el importe) |

Cada handler acepta solo el token de servicio de su productor. `ListNotifications` devuelve los últimos 50 avisos de quien llama.

## Una sola vez por evento

El id de cada aviso es `<evento>:<destinatario>`, y se escribe con `upsert` y `$setOnInsert`. El inbox evita reprocesar un evento, y aun si el registro del inbox se pierde, repetir el evento no duplica avisos.

Los avisos migrados del monolito conservan su `ObjectId`.

## Contrato con el frontend

Un `map` de proto no admite `null`. Los valores nulos del aviso, como `winnerId` en una subasta sin ganador, se omiten en gRPC y el api-gateway los repone como `null`, que es la forma que el frontend ya consume.

## Estructura

```
src/
  api/grpc/          NotificationService y NotificationEventHandlerService
  internal/
    domain/          construcción de avisos por evento
    application/     NotificationEvents, ListNotifications y el puerto NotificationStore
    infrastructure/  Mongo (artauction_notification)
  notification.module.ts
```

## Ejecutar

```bash
cp .env.example .env
npm run build -w @artauction/notification-service
npm start -w @artauction/notification-service
```

## Pruebas

`npm test -w @artauction/notification-service`:

- destinatarios de cada evento;
- eventos repetidos sin duplicados, aunque se pierda el registro del inbox;
- rechazo de un evento sin id.
