export interface AuditFinishedNotice {
  lotId: string;
  sellerId: string;
  verdict: string;
}

export interface AuctionClosedNotice {
  auctionId: string;
  lotId: string;
  sellerId: string;
  winnerId: string | null;
  amount: string;
}

export interface OutcomeNotifier {
  auditFinished(notice: AuditFinishedNotice): Promise<void>;
  auctionClosed(notice: AuctionClosedNotice): Promise<void>;
}

export const OUTCOME_NOTIFIER = Symbol('OUTCOME_NOTIFIER');

export interface GalleryGrants {
  grantOwnLot(input: { ownerId: string; lotId: string }): Promise<void>;
  grantWonLot(input: { ownerId: string; lotId: string }): Promise<void>;
}

export const GALLERY_GRANTS = Symbol('GALLERY_GRANTS');
