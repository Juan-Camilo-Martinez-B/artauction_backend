import type { ServerWritableStream } from '@grpc/grpc-js';
import { auctionV1 } from '@artauction/contracts';
import { DomainError, type StructuredLogger } from '@artauction/platform';
import { unary, type CallerResolver } from '@artauction/service-kit';
import type { Auction, Bid, CloseReason } from '../../internal/domain/auction';
import { buyNowOpen, type AuctionStatus } from '../../internal/domain/auction-rules';
import { toCents } from '../../internal/domain/money';
import type { BuyNow, PlaceBid, WithdrawBid } from '../../internal/application/bidding';
import type { LiveNotice } from '../../internal/application/ports';
import type { BatchGetAuctionSummaries, GetAuction, GetBidByReservation, ListLiveAuctions } from '../../internal/application/queries';
import type { OpenAuction } from '../../internal/application/scheduling';
import type { LiveBus } from '../live/live-bus';

export interface AuctionUseCases {
  getAuction: GetAuction;
  openAuction: OpenAuction;
  placeBid: PlaceBid;
  buyNow: BuyNow;
  withdrawBid: WithdrawBid;
  summaries: BatchGetAuctionSummaries;
  live: ListLiveAuctions;
  bidByReservation: GetBidByReservation;
}

const STATUS_TO_PROTO: Readonly<Record<AuctionStatus, auctionV1.AuctionStatus>> = {
  PROGRAMADA: auctionV1.AuctionStatus.AUCTION_STATUS_PROGRAMADA,
  ACTIVA: auctionV1.AuctionStatus.AUCTION_STATUS_ACTIVA,
  CERRADA: auctionV1.AuctionStatus.AUCTION_STATUS_CERRADA,
};

const CLOSE_REASON_TO_PROTO: Readonly<Record<CloseReason, auctionV1.CloseReason>> = {
  TIME: auctionV1.CloseReason.CLOSE_REASON_TIME,
  BUY_NOW: auctionV1.CloseReason.CLOSE_REASON_BUY_NOW,
};

/** Compra inmediata y su vigencia, con el reloj del servidor. */
function buyNowFields(auction: Auction) {
  return {
    buyNowPrice: auction.buyNowPrice,
    buyNowAvailable: buyNowOpen({
      now: new Date(),
      status: auction.status,
      endsAt: auction.endsAt,
      currentPriceCents: toCents(auction.currentPrice),
      buyNowCents: toCents(auction.buyNowPrice),
    }),
    closedBy: auction.closedBy ? CLOSE_REASON_TO_PROTO[auction.closedBy] : auctionV1.CloseReason.CLOSE_REASON_UNSPECIFIED,
  };
}

function summaryToProto(auction: Auction): auctionV1.AuctionSummary {
  return auctionV1.AuctionSummary.fromPartial({
    auctionId: auction.id,
    lotId: auction.lotId,
    status: STATUS_TO_PROTO[auction.status],
    currentPrice: auction.currentPrice,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    saleDescription: auction.saleDescription ?? undefined,
    currency: auction.currency,
    ...buyNowFields(auction),
  });
}

function bidToProto(bid: Bid): auctionV1.Bid {
  return auctionV1.Bid.fromPartial(bid);
}

function auctionToProto(auction: Auction, bids: Bid[] = []): auctionV1.Auction {
  return auctionV1.Auction.fromPartial({
    id: auction.id,
    lotId: auction.lotId,
    sellerId: auction.sellerId,
    startPrice: auction.startPrice,
    currentPrice: auction.currentPrice,
    minIncrement: auction.minIncrement,
    currency: auction.currency,
    startsAt: auction.startsAt,
    endsAt: auction.endsAt,
    initialEndsAt: auction.initialEndsAt,
    status: STATUS_TO_PROTO[auction.status],
    winnerId: auction.winnerId ?? undefined,
    extensionCount: auction.extensionCount,
    durationMinutes: auction.durationMinutes,
    saleDescription: auction.saleDescription ?? undefined,
    bids: bids.map(bidToProto),
    ...buyNowFields(auction),
  });
}

function noticeToProto(notice: LiveNotice): auctionV1.WatchAuctionResponse {
  const serverTime = new Date();
  if (notice.kind === 'bid-accepted') {
    return auctionV1.WatchAuctionResponse.fromPartial({
      serverTime,
      event: {
        $case: 'bidAccepted',
        value: {
          auctionId: notice.auctionId,
          bidId: notice.bidId,
          bidderId: notice.bidderId,
          amount: notice.amount,
          endsAt: notice.endsAt,
          extended: notice.extended,
        },
      },
    });
  }
  return auctionV1.WatchAuctionResponse.fromPartial({
    serverTime,
    event: {
      $case: 'auctionClosed',
      value: {
        auctionId: notice.auctionId,
        lotId: notice.lotId,
        winnerId: notice.winnerId ?? undefined,
        amount: notice.amount,
        closedBy: CLOSE_REASON_TO_PROTO[notice.closedBy],
      },
    },
  });
}

function requiredDate(value: Date | undefined, label: string): Date {
  if (!value) {
    throw DomainError.invalid(`Falta ${label}`);
  }
  return value;
}

/** Frontera gRPC publica de auction-service. */
export function auctionGrpcService(
  useCases: AuctionUseCases,
  callers: CallerResolver,
  live: LiveBus,
  logger: StructuredLogger,
): auctionV1.AuctionServiceServer {
  return {
    getAuction: unary(logger, 'GetAuction', async (request) => {
      const { auction, bids } = await useCases.getAuction.execute(request.auctionId);
      return auctionV1.GetAuctionResponse.fromPartial({ auction: auctionToProto(auction, bids), serverTime: new Date() });
    }),

    openAuction: unary(logger, 'OpenAuction', async (request, context) => {
      const auction = await useCases.openAuction.execute(callers.user(context), {
        lotId: request.lotId,
        startPrice: request.startPrice,
        minIncrement: request.minIncrement,
        startsAt: requiredDate(request.startsAt, 'el inicio'),
        endsAt: requiredDate(request.endsAt, 'el cierre'),
      });
      return auctionV1.OpenAuctionResponse.fromPartial({ auction: auctionToProto(auction) });
    }),

    placeBid: unary(logger, 'PlaceBid', async (request, context) => {
      const placed = await useCases.placeBid.execute(callers.user(context).userId, {
        auctionId: request.auctionId,
        amount: request.amount,
        idempotencyKey: request.idempotencyKey,
      });
      return auctionV1.PlaceBidResponse.fromPartial(placed);
    }),

    buyNow: unary(logger, 'BuyNow', async (request, context) => {
      const bought = await useCases.buyNow.execute(callers.user(context).userId, {
        auctionId: request.auctionId,
        idempotencyKey: request.idempotencyKey,
      });
      return auctionV1.BuyNowResponse.fromPartial(bought);
    }),

    withdrawBid: unary(logger, 'WithdrawBid', async (request, context) => {
      const result = await useCases.withdrawBid.execute(callers.user(context).userId, request.auctionId);
      return auctionV1.WithdrawBidResponse.fromPartial({
        auctionId: result.auctionId,
        releasedCoins: result.released,
        currentPrice: result.currentPrice,
      });
    }),

    batchGetAuctionSummaries: unary(logger, 'BatchGetAuctionSummaries', async (request) => {
      const auctions = await useCases.summaries.execute(request.lotIds);
      return auctionV1.BatchGetAuctionSummariesResponse.fromPartial({ summaries: auctions.map(summaryToProto) });
    }),

    listLiveAuctions: unary(logger, 'ListLiveAuctions', async (request) => {
      const auctions = await useCases.live.execute(request.limit, request.horizonMinutes);
      return auctionV1.ListLiveAuctionsResponse.fromPartial({ summaries: auctions.map(summaryToProto) });
    }),

    getBidByReservation: unary(logger, 'GetBidByReservation', async (request, context) => {
      callers.service(context, ['wallet-service']);
      return auctionV1.GetBidByReservationResponse.fromPartial(await useCases.bidByReservation.execute(request.reservationId));
    }),

    // Stream de servidor: cada aviso de la sala se envia mientras el cliente
    // siga conectado; al cancelar se libera el oyente del bus.
    watchAuction: (call: ServerWritableStream<auctionV1.WatchAuctionRequest, auctionV1.WatchAuctionResponse>) => {
      const auctionId = call.request.auctionId;
      const unsubscribe = live.subscribe(auctionId, (notice) => {
        if (!call.cancelled) {
          call.write(noticeToProto(notice));
        }
      });
      const close = () => {
        unsubscribe();
      };
      call.on('cancelled', close);
      call.on('close', close);
      call.on('error', close);
    },
  };
}
