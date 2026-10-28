# wallet-service

Bolsillo de **artacoins** de ArtAuction AI: saldo, recargas, retenciones de las pujas y liquidación de ventas. Es el dueño del esquema `wallet`. Expone `artauction.wallet.v1.WalletService` y `WalletEventHandlerService` por gRPC (puerto `50053`).

Una artacoin cuesta 1 USD. La pasarela de pago es **simulada**: no mueve dinero real ni guarda el número de tarjeta ni el CVV, solo la marca y los últimos cuatro dígitos.

## Recarga idempotente

`TopUp` exige una clave de idempotencia por intento de pago (cabecera `Idempotency-Key` en el gateway).

| Situación | Resultado |
|---|---|
| Clave nueva | Se cobra en la pasarela y se guardan la orden y el abono **en la misma transacción** |
| Misma clave, mismo contenido | Devuelve la orden original sin cobrar otra vez |
| Misma clave, otro contenido | `409 Conflict` |
| Dos peticiones simultáneas con la misma clave | Una gana por el índice único; la otra recibe la orden ganadora |
| Tarjeta rechazada y reintento con la misma clave | Sigue rechazada; no se cobra |

El contenido se compara con una huella SHA-256 de la cantidad, los últimos cuatro dígitos, la caducidad y el titular; el número completo nunca se guarda. La clave también viaja a la pasarela, como en Stripe, para que el proveedor no cobre dos veces.

En el monolito la orden y el abono iban en transacciones separadas: una caída entre ambas cobraba sin acreditar.

## Retenciones de las pujas (TCC)

Una puja retiene artacoins en tres pasos (Try-Confirm-Cancel):

1. **Try** (`TryHold`, lo llama auction antes de guardar la puja): reserva solo la diferencia entre lo ya retenido y la nueva oferta. La reserva queda `PENDIENTE` y vence a los 2 minutos. Es idempotente por la clave de la puja.
2. **Confirm** (evento `BidAccepted`): la reserva pasa a ser la retención del postor en esa subasta.
3. **Cancel**: `BidWithdrawn` devuelve toda la retención del postor; una reserva vencida se resuelve en el barrido.

El barrido nunca libera a ciegas: antes pregunta a auction (`GetBidByReservation`) si la puja existe. Si existe, confirma; si no, devuelve las artacoins; si auction no responde, espera al siguiente barrido.

## Cierre de subasta

`AuctionClosed` canjea la retención del ganador, devuelve la de los demás y **abona al vendedor** el precio de venta menos la comisión de la plataforma (`PLATFORM_FEE_BPS`, 10 % por defecto, redondeada a favor del vendedor). La comisión se registra en `wallet.platform_fees`, cuya llave primaria por subasta impide cobrarla dos veces. `AuctionRescheduled` devuelve todas las retenciones.

El pago al vendedor y la retención TCC se activan cuando exista auction-service (fase F6). Mientras tanto el monolito sigue reteniendo y cerrando directamente sobre las mismas tablas.

## Concurrencia

Todo cambio de saldo bloquea primero el bolsillo con `SELECT ... FOR UPDATE`. Cuando una operación toca varios bolsillos (un cierre con varios postores y el vendedor), los bloquea **en orden de id**: dos transacciones nunca se esperan en sentidos opuestos, así no hay deadlocks. Cada evento entrante se aplica una sola vez gracias a `wallet.inbox`.

## Estructura

```
src/
  api/grpc/            WalletService y WalletEventHandlerService
  api/clients/         AuctionBidLookup: implementa el puerto BidLookup con gRPC
  internal/
    domain/            reglas de artacoins, recarga, retención, comisión y reservas vencidas
    application/       casos de uso y puertos (WalletRepository, PaymentGateway, BidLookup)
    infrastructure/    Prisma (esquema wallet) y la pasarela simulada
  wallet.module.ts     raíz de composición y barrido periódico de reservas
```

Para usar una pasarela real, como Stripe, basta otra implementación de `PaymentGateway`: los casos de uso no cambian.

## Ejecutar

```bash
cp .env.example .env     # completar DATABASE_URL y SERVICE_CLIENT_SECRET
npm run build -w @artauction/wallet-service
npm start -w @artauction/wallet-service
```

## Pruebas

`npm test -w @artauction/wallet-service`: pasarela simulada, recarga idempotente (repetición, conflicto, rechazo), retención incremental e insuficiencia de saldo, comisión del vendedor y decisiones del barrido.
