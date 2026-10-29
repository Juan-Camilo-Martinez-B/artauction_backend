# ADR 0004: outbox, inbox y sagas para los flujos entre servicios

Estado: aceptado.

## Contexto

En el monolito una transaccion Postgres cubria la puja, la retencion de artacoins, el cierre, la venta, la galeria ganada y la notificacion. Entre servicios no hay transacciones distribuidas.

## Decision

- **Transactional outbox.** El servicio que produce un evento lo inserta en su tabla `outbox` dentro de la misma transaccion que el cambio de estado. Un relay lee el outbox en orden y entrega el evento llamando por gRPC al metodo correspondiente de cada consumidor, con reintentos y backoff exponencial. No se anade un broker.
- **Idempotent consumer.** Cada consumidor registra el id del evento en su tabla `inbox` en la misma transaccion que lo aplica. Un evento repetido se ignora. La entrega es al menos una vez y el efecto es exactamente una vez.
- **Sagas coreografiadas.** El cierre de subasta y la auditoria son sagas: cada paso local emite un evento y los consumidores reaccionan.
- **TCC para retenciones.** La puja reserva artacoins con `TryHold` (pendiente, con TTL), la confirma con `ConfirmHold` por el outbox y la cancela con `ReleaseHold`. Una reserva sin confirmar se libera sola al vencer.

## Consecuencias

- Consistencia eventual: el estado `VENDIDA` del lote en catalog puede tardar milisegundos en reflejar el cierre de auction.
- Cada consumidor debe ser idempotente; se prueba con eventos repetidos.
