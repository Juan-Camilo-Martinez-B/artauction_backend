import { Body, Controller, Get, Headers, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { auctionV1 } from '@artauction/contracts';
import { invoke } from '@artauction/service-kit';
import { AUCTION_CLIENT } from '../../../clients/grpc-clients';
import type { GatewayConfig } from '../../../config';
import { GATEWAY_CONFIG } from '../tokens';
import { auctionDetailJson, placedBidJson } from './auction.presenter';
import { OpenAuctionDto, PlaceBidDto } from './auctions.dto';

/**
 * Rutas /auctions, servidas por auction-service. La autorizacion (rol de
 * vendedor, dueno de la obra) la decide el servicio con el token reenviado.
 */
@Controller('auctions')
export class AuctionsController {
  constructor(
    @Inject(AUCTION_CLIENT) private readonly auctions: auctionV1.AuctionServiceClient,
    @Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig,
  ) {}

  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    const response = await invoke(this.auctions.getAuction.bind(this.auctions), { auctionId: id }, this.options());
    if (!response.auction) {
      throw new Error('GetAuction respondio sin subasta');
    }
    return { auction: auctionDetailJson(response.auction), serverTime: (response.serverTime ?? new Date()).toISOString() };
  }

  @Post()
  async open(@Headers('authorization') authorization: string | undefined, @Body() body: OpenAuctionDto) {
    const response = await invoke(
      this.auctions.openAuction.bind(this.auctions),
      auctionV1.OpenAuctionRequest.fromPartial({
        lotId: body.lotId,
        startPrice: body.startPrice,
        minIncrement: body.minIncrement,
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
      }),
      this.options(authorization),
    );
    if (!response.auction) {
      throw new Error('OpenAuction respondio sin subasta');
    }
    return auctionDetailJson(response.auction);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post(':id/bids')
  async place(
    @Headers('authorization') authorization: string | undefined,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PlaceBidDto,
  ) {
    const placed = await invoke(
      this.auctions.placeBid.bind(this.auctions),
      { auctionId: id, amount: body.amount, idempotencyKey: body.idempotencyKey },
      this.options(authorization),
    );
    return placedBidJson(placed);
  }

  @Post(':id/withdraw')
  async withdraw(@Headers('authorization') authorization: string | undefined, @Param('id', ParseUUIDPipe) id: string) {
    const result = await invoke(this.auctions.withdrawBid.bind(this.auctions), { auctionId: id }, this.options(authorization));
    return { auctionId: result.auctionId, released: result.releasedCoins, currentPrice: result.currentPrice };
  }

  private options(authorization?: string) {
    return { deadlineMs: this.config.GRPC_DEADLINE_MS, authorization };
  }
}
