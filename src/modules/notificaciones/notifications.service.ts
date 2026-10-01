import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { AuctionClosedNotice, AuditFinishedNotice, OutcomeNotifier } from '../../common/outcomes';
import { Notification } from './notification.schema';

@Injectable()
export class NotificationsService implements OutcomeNotifier {
  constructor(@InjectModel(Notification.name) private readonly notifications: Model<Notification>) {}

  async auditFinished(notice: AuditFinishedNotice): Promise<void> {
    await this.notifications.create({
      userId: notice.sellerId,
      kind: 'AUDIT',
      payload: { lotId: notice.lotId, verdict: notice.verdict },
      createdAt: new Date(),
      readAt: null,
    });
  }

  async auctionClosed(notice: AuctionClosedNotice): Promise<void> {
    const recipients = notice.winnerId ? [notice.sellerId, notice.winnerId] : [notice.sellerId];
    await this.notifications.create(
      recipients.map((userId) => ({
        userId,
        kind: 'AUCTION_CLOSED' as const,
        payload: {
          auctionId: notice.auctionId,
          lotId: notice.lotId,
          winnerId: notice.winnerId,
          amount: notice.amount,
        },
        createdAt: new Date(),
        readAt: null,
      })),
    );
  }

  list(userId: string) {
    return this.notifications.find({ userId }).sort({ createdAt: -1 }).limit(50).lean().exec();
  }
}
