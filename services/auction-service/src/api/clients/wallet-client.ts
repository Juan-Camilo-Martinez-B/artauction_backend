import { status } from '@grpc/grpc-js';
import { walletV1 } from '@artauction/contracts';
import { DomainError, isServiceError } from '@artauction/platform';
import { invoke, type ServiceTokenProvider } from '@artauction/service-kit';
import type { WalletPort } from '../../internal/application/ports';

/**
 * Implementa WalletPort con WalletService.TryHold. Traduce los errores de
 * wallet a errores de dominio de auction (capa anticorrupcion): el saldo
 * insuficiente llega al postor como 400, igual que en el monolito.
 */
export class GrpcWalletClient implements WalletPort {
  constructor(
    private readonly wallet: walletV1.WalletServiceClient,
    private readonly tokens: ServiceTokenProvider,
  ) {}

  async tryHold(input: { reservationId: string; auctionId: string; bidderId: string; nextCoins: number }): Promise<{ reservedCoins: number }> {
    try {
      const response = await invoke(this.wallet.tryHold.bind(this.wallet), walletV1.TryHoldRequest.fromPartial(input), {
        deadlineMs: 3_000,
        authorization: await this.tokens.authorization(),
      });
      return { reservedCoins: response.reservedCoins };
    } catch (error) {
      throw translate(error);
    }
  }
}

function translate(error: unknown): unknown {
  if (!isServiceError(error)) {
    return error;
  }
  switch (error.code) {
    case status.FAILED_PRECONDITION:
    case status.INVALID_ARGUMENT:
      return DomainError.invalid(error.details);
    case status.UNAVAILABLE:
    case status.DEADLINE_EXCEEDED:
      return DomainError.unavailable('El bolsillo no responde. Intenta la puja de nuevo.');
    default:
      return error;
  }
}
