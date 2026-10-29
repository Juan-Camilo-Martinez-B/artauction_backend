import { BadRequestException, Body, Controller, Get, Headers, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsInt, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';
import { walletV1 } from '@artauction/contracts';
import { invoke } from '@artauction/service-kit';
import { WALLET_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG } from '../tokens';

export class TopUpDto {
  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(10_000)
  coins!: number;

  @IsString()
  @MinLength(12)
  @MaxLength(23)
  cardNumber!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(80)
  cardName!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  expMonth!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  expYear!: number;

  @IsString()
  @Matches(/^\d{3,4}$/)
  cvv!: string;
}

const KIND_NAMES: ReadonlyMap<walletV1.EntryKind, string> = new Map([
  [walletV1.EntryKind.ENTRY_KIND_RECARGA, 'RECARGA'],
  [walletV1.EntryKind.ENTRY_KIND_RETENCION, 'RETENCION'],
  [walletV1.EntryKind.ENTRY_KIND_LIBERACION, 'LIBERACION'],
  [walletV1.EntryKind.ENTRY_KIND_CANJE, 'CANJE'],
  [walletV1.EntryKind.ENTRY_KIND_VENTA, 'VENTA'],
]);

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** Rutas /wallet, servidas por wallet-service. Los datos de tarjeta no se registran en logs. */
@Controller('wallet')
export class WalletController {
  constructor(
    @Inject(WALLET_CLIENT) private readonly wallet: walletV1.WalletServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Get()
  async snapshot(@Headers('authorization') authorization: string | undefined) {
    const response = await invoke(this.wallet.getWallet.bind(this.wallet), {}, this.options(authorization));
    return {
      balance: response.balance,
      held: response.held,
      entries: response.entries.map((item) => ({
        id: item.id,
        kind: KIND_NAMES.get(item.kind) ?? 'RECARGA',
        coins: item.coins,
        createdAt: item.createdAt?.toISOString() ?? null,
      })),
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('top-ups')
  async topUp(
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: TopUpDto,
  ) {
    if (idempotencyKey === undefined || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException('Falta la cabecera Idempotency-Key (8 a 100 caracteres alfanumericos).');
    }
    const response = await invoke(
      this.wallet.topUp.bind(this.wallet),
      walletV1.TopUpRequest.fromPartial({
        coins: body.coins,
        cardNumber: body.cardNumber,
        cardName: body.cardName,
        expMonth: body.expMonth,
        expYear: body.expYear,
        cvv: body.cvv,
        idempotencyKey,
      }),
      this.options(authorization),
    );
    return { balance: response.balance, credited: response.credited, last4: response.last4, orderId: response.orderId };
  }

  private options(authorization: string | undefined) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}
