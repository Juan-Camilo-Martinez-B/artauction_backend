# ADR 0008: pujas con TCC y sala en vivo sobre streams gRPC

Estado: aceptado.

## Contexto

En el monolito una puja bloqueaba la subasta y el bolsillo en una sola transacción de Postgres. Con auction-service y wallet-service separados, cada uno dueño de su esquema, no hay transacción común. La sala en vivo (Socket.IO) también vivía en el monolito, junto al bus de eventos en memoria que la alimentaba.

## Decisión

- **Try-Confirm-Cancel para el saldo.** auction llama a `wallet.TryHold` **antes** de abrir su transacción, con la clave de idempotencia de la puja. La reserva vence a los 2 minutos. La transacción local bloquea la sala, revalida, guarda la puja y escribe `BidAccepted` en el outbox con el `reservation_id`. wallet confirma al recibir el evento.
- **Nunca una llamada remota con una fila bloqueada.** Una validación previa laxa evita reservar para pujas que de seguro no valen. La validación estricta se repite dentro del bloqueo.
- **Reservas huérfanas resueltas por consulta.** Si la transacción falla tras el Try, wallet no libera a ciegas al vencer: pregunta `GetBidByReservation` (solo con token de wallet-service) y confirma o devuelve según exista la puja.
- **Sala en vivo en el gateway.** auction-service expone `WatchAuction`, un stream de servidor por sala. El gateway mantiene un solo stream por sala con espectadores (conteo de referencias, reconexión con backoff) y lo traduce al contrato Socket.IO v1 sin cambios para el frontend.
- **Una instancia de auction-service** en esta fase. El bus de avisos es en memoria y el programador corre en el proceso.
- **Copia de la obra en `auction`.** `seller_id` y `lot_title` llegan por eventos. Hasta F7, un trigger transitorio de la base completa la copia de las subastas creadas por la auditoría del monolito.

## Alternativas descartadas

- **Saga coreografiada sin Try** (retener después de aceptar la puja): permitía pujas aceptadas sin saldo y obligaba a revertir precios ya publicados en la sala.
- **Mantener el bloqueo de la sala durante `TryHold`**: una latencia de wallet frenaría toda la sala y abriría la puerta a deadlocks distribuidos.
- **Socket.IO dentro de auction-service**: obligaría a exponer el servicio al navegador y a duplicar la autenticación y el CORS que ya resuelve el gateway.

## Consecuencias

- El saldo nunca se duplica ni se pierde. En el peor caso, una reserva huérfana queda retenida hasta 2 minutos más el intervalo del barrido.
- Los avisos emitidos mientras el stream de una sala está cortado no llegan por socket. El frontend recupera el estado con `GET /auctions/:id`.
- Escalar auction-service exige un bus compartido para los avisos (Redis pub/sub o `LISTEN/NOTIFY`) y un líder para el programador. Hasta entonces, `max-instances=1`.
- El token del socket se fija en el handshake y caduca antes que la sesión. La puja por REST, que el frontend siempre envía con un token renovado y la misma clave, es la que manda.
