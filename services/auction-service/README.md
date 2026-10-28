# auction-service

Subastas en vivo de ArtAuction AI: salas, pujas en artacoins, anti-sniping, retiros y cierre. Es el dueño del esquema `auction` (`auctions`, `bids`, `transactions`, `outbox`, `inbox`). Expone `artauction.auction.v1.AuctionService` y `AuctionEventHandlerService` por gRPC (puerto `50054`).

El reloj es siempre el del servidor. Cada respuesta que alimenta el countdown del frontend lleva `server_time`.

## Ciclo de una sala

```
PROGRAMADA --(starts_at, programador)--> ACTIVA --(ends_at)--> CERRADA      (con pujas)
                                            \--------------> PROGRAMADA   (sin pujas: nueva ventana)
```

- **Apertura automática.** `AuditCompleted`, cuando el veredicto es aprobado, y `LotPublished` crean la sala con una ventana al azar entre 15 minutos y 48 horas. La duración crece con el score de autenticidad: 30 minutos con score 40 y 180 con score 100. Son idempotentes: una obra tiene como mucho una subasta.
- **Apertura manual.** `OpenAuction`, para el vendedor dueño de la obra o un administrador. La obra debe estar `APROBADO` o `PUBLICADA` en catalog, que se consulta por gRPC.
- **Programador.** Cada `SCHEDULER_INTERVAL_MS` abre las salas vencidas y cierra o reprograma las que terminan. Lo hace en lotes, con `FOR UPDATE SKIP LOCKED` y los índices parciales `auctions_due_to_open_idx` y `auctions_due_to_close_idx`.

## Reglas de puja

| Regla | Detalle |
|---|---|
| Artacoins enteras | `850` o `850.00`, nunca `850.50` |
| Primera puja | Al menos el precio de salida |
| Siguientes | Al menos el precio actual más el incremento mínimo; nadie publica el mismo importe que otro |
| Obra propia | El vendedor no puja en su sala; la copia `seller_id` está en el propio esquema |
| Anti-sniping | Una puja en los últimos 30 s alarga el cierre 30 s |
| Retiro | Solo si faltan 4 minutos o más. Libera la retención y devuelve el precio a la siguiente oferta |
| Idempotencia | La `idempotency_key` de la puja es única. Repetirla devuelve la misma puja con `idempotent: true` |

## Pujas con TCC sin bloqueo abierto

La puja necesita dos recursos de dueños distintos: la sala (`auction`) y el saldo (`wallet`). Se coordinan con Try-Confirm-Cancel, y la llamada remota nunca ocurre con una fila bloqueada:

1. **Validación previa sin bloqueo.** Esta comprobación es laxa: descarta lo que de seguro no vale (sala cerrada, obra propia, importe mal formado) sin tocar el bolsillo.
2. **Try.** `wallet.TryHold` reserva la diferencia entre lo ya retenido y la nueva oferta, con la misma clave de idempotencia. La reserva vence a los 2 minutos.
3. **Transacción local.** Bloquea la sala (`FOR UPDATE`), repite la validación estricta, desactiva la puja anterior del postor, guarda la nueva, mueve precio y cierre, y escribe `BidAccepted` en el outbox con el `reservation_id` y las artacoins reservadas.
4. **Confirm.** wallet consume `BidAccepted` y confirma la reserva.

Si la transacción falla después del Try, por ejemplo porque otro postor ganó la carrera, la reserva queda **huérfana**. wallet la resuelve al vencer: antes de liberarla pregunta `GetBidByReservation`, que solo acepta el token de wallet-service. Si la puja existe, confirma; si no, devuelve las artacoins. Nunca se pierde ni se duplica saldo.

Dentro del proceso, las pujas y retiros de una misma sala pasan por una cola serial por subasta (`KeyedSerialQueue`), así dos pujas de la misma sala no compiten por la reserva.

## Eventos

Escritos en `auction.outbox` en la misma transacción que el cambio y entregados por gRPC con reintentos y orden por subasta:

| Evento | Consumidores |
|---|---|
| `AuctionStarted` | catalog (obra `EN_SUBASTA`) |
| `BidAccepted` | wallet (confirma la reserva) |
| `BidWithdrawn` | wallet (devuelve la retención) |
| `AuctionClosed` | wallet (canje, liberaciones, pago al vendedor), catalog (`VENDIDA`), gallery y notification |
| `AuctionRescheduled` | wallet (libera todo), catalog (vuelve a `PUBLICADA`) |

Hasta F8, gallery y notification los atiende el servidor gRPC legado del monolito (`GALLERY_EVENTS_GRPC_URL` y `NOTIFICATION_EVENTS_GRPC_URL`).

## Sala en vivo

`WatchAuction` es un stream de servidor con los avisos `BidAccepted` y `AuctionClosed` de una sala. El api-gateway abre uno por sala con espectadores y lo reenvía por Socket.IO con el contrato de siempre (`bid:accepted`, `auction:closed`).

**Límite: una sola instancia.** Los avisos en vivo salen de un bus en memoria (`LiveBus`) y el programador corre en cada proceso. Con dos instancias, un espectador conectado a una no vería las pujas aceptadas por la otra. Los cierres no se duplicarían, gracias a `SKIP LOCKED` y a las comprobaciones de estado, pero sí se repartiría el trabajo sin coordinación. Escalar horizontalmente exige publicar los avisos en un bus compartido (Redis pub/sub o `LISTEN/NOTIFY` de Postgres) y elegir un líder para el programador.

## Copia de la obra

Para validar sin leer `catalog`, cada subasta guarda `seller_id` y `lot_title`, que llegan en los eventos y en la apertura manual. Mientras la auditoría siga en el monolito (hasta F7), este crea subastas sin la copia. Un trigger transitorio de la base (`auctions_fill_lot_copy`, migración `0018` de artauction_bd) la completa, y se elimina en la migración de contract de F7.

## Estructura

```
src/
  api/grpc/          AuctionService (incluye WatchAuction) y AuctionEventHandlerService
  api/clients/       wallet (TryHold) y catalog (ficha de la obra) por gRPC
  api/events/        rutas del outbox hacia cada consumidor
  api/live/          LiveBus: avisos en vivo por sala
  internal/
    domain/          reglas de la sala, dinero en centavos y eventos
    application/     PlaceBid, WithdrawBid, OpenAuction, ScheduleApprovedLot, RunScheduler, consultas y puertos
    infrastructure/  Prisma (esquema auction) con unidad de trabajo y bloqueos
  auction.module.ts  raíz de composición, relay del outbox y programador
```

La capa `internal` no importa nada de `api` ni de otros servicios; ESLint lo impide con `no-restricted-imports`.

## Ejecutar

```bash
cp .env.example .env     # completar DATABASE_URL (usuario auction_svc) y SERVICE_CLIENT_SECRET
npm run build -w @artauction/auction-service
npm start -w @artauction/auction-service
```

Con auction-service activo, el monolito debe arrancar con `AUCTIONS_IN_SERVICE=true` para que no abra ni cierre salas.

## Pruebas

`npm test -w @artauction/auction-service`:

- reglas de la sala: precio de salida, incremento, anti-sniping, obra propia, retiro y duración por score;
- puja con TCC: reserva antes de la transacción, repetición de la clave sin segunda reserva, puja inválida sin tocar el bolsillo, falta de saldo, dos postores con el mismo importe y retiro del líder;
- programador: cierre con ganador, reprogramación de la sala vacía y apertura con `AuctionStarted`.
