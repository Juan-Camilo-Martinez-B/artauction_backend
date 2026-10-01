import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';

export interface BidAcceptedEvent {
  version: 1;
  auctionId: string;
  bidId: string;
  bidderId: string;
  amount: string;
  endsAt: string;
  extended: boolean;
  serverTime: string;
}

export interface AuctionClosedEvent {
  version: 1;
  auctionId: string;
  lotId: string;
  winnerId: string | null;
  amount: string;
  serverTime: string;
}

export interface BidRejectedEvent {
  version: 1;
  auctionId: string;
  message: string;
  serverTime: string;
}

@Injectable()
export class AuctionBus {
  private readonly emitter = new EventEmitter();

  bidAccepted(event: BidAcceptedEvent): void {
    this.emitter.emit('bid:accepted', event);
  }

  auctionClosed(event: AuctionClosedEvent): void {
    this.emitter.emit('auction:closed', event);
  }

  onBidAccepted(listener: (event: BidAcceptedEvent) => void): void {
    this.emitter.on('bid:accepted', listener);
  }

  onAuctionClosed(listener: (event: AuctionClosedEvent) => void): void {
    this.emitter.on('auction:closed', listener);
  }
}
