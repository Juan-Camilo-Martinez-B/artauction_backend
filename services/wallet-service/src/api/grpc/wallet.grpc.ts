import { walletV1 } from '@artauction/contracts';
import type { StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { EntryKind } from '../../internal/domain/wallet';
import type { GetWallet, TopUp, TryHold } from '../../internal/application/use-cases';

export interface WalletUseCases {
  getWallet: GetWallet;
  topUp: TopUp;
  tryHold: TryHold;
}

const KIND_TO_PROTO: Readonly<Record<EntryKind, walletV1.EntryKind>> = {
  RECARGA: walletV1.EntryKind.ENTRY_KIND_RECARGA,
  RETENCION: walletV1.EntryKind.ENTRY_KIND_RETENCION,
  LIBERACION: walletV1.EntryKind.ENTRY_KIND_LIBERACION,
  CANJE: walletV1.EntryKind.ENTRY_KIND_CANJE,
  VENTA: walletV1.EntryKind.ENTRY_KIND_VENTA,
};

/** Frontera gRPC publica del bolsillo. */
export function walletGrpcService(
  useCases: WalletUseCases,
  callers: CallerResolver,
  logger: StructuredLogger,
): walletV1.WalletServiceServer {
  return {
    getWallet: unary(logger, 'GetWallet', async (_request, context) => {
      const snapshot = await useCases.getWallet.execute(callers.user(context).userId);
      return walletV1.GetWalletResponse.fromPartial({
        balance: snapshot.balance,
        held: snapshot.held,
        entries: snapshot.entries.map((item) => ({
          id: item.id,
          kind: KIND_TO_PROTO[item.kind],
          coins: item.coins,
          createdAt: item.createdAt,
        })),
      });
    }),

    topUp: unary(logger, 'TopUp', async (request, context) => {
      const result = await useCases.topUp.execute(callers.user(context).userId, {
        idempotencyKey: request.idempotencyKey,
        coins: request.coins,
        card: {
          number: request.cardNumber,
          name: request.cardName,
          expMonth: request.expMonth,
          expYear: request.expYear,
          cvv: request.cvv,
        },
      });
      return walletV1.TopUpResponse.fromPartial(result);
    }),

    tryHold: unary(logger, 'TryHold', async (request, context) => {
      callers.service(context, ['auction-service']);
      const result = await useCases.tryHold.execute({
        reservationId: request.reservationId,
        auctionId: request.auctionId,
        bidderId: request.bidderId,
        nextCoins: request.nextCoins,
      });
      return walletV1.TryHoldResponse.fromPartial(result);
    }),
  };
}
