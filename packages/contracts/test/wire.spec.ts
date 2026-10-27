import { auctionV1, catalogHandlersV1, galleryV1, auditEventsV1 } from '../src';

describe('contratos en el cable', () => {
  it('conserva fechas y la union oneof del stream de la sala', () => {
    const endsAt = new Date('2026-10-27T15:00:30.000Z');
    const message = auctionV1.WatchAuctionResponse.fromPartial({
      serverTime: new Date('2026-10-27T15:00:00.000Z'),
      event: {
        $case: 'bidAccepted',
        value: { auctionId: 'a1', bidId: 'b1', bidderId: 'u1', amount: '120.00', endsAt, extended: true },
      },
    });
    const decoded = auctionV1.WatchAuctionResponse.decode(auctionV1.WatchAuctionResponse.encode(message).finish());
    expect(decoded.event?.$case).toBe('bidAccepted');
    if (decoded.event?.$case === 'bidAccepted') {
      expect(decoded.event.value.endsAt?.toISOString()).toBe(endsAt.toISOString());
      expect(decoded.event.value.amount).toBe('120.00');
    }
  });

  it('transporta la configuracion 3D como Struct sin perder la forma', () => {
    const appliedConfig = { schemaVersion: 1, palette: { wall: '#f4efe6' }, architecture: { roomDepth: 10 } };
    const message = galleryV1.PersonalGallery.fromPartial({ id: 'g1', preferences: {}, appliedConfig });
    const decoded = galleryV1.PersonalGallery.decode(galleryV1.PersonalGallery.encode(message).finish());
    expect(decoded.appliedConfig).toEqual(appliedConfig);
    expect(decoded.suggestedConfig).toBeUndefined();
  });

  it('anida el evento de otro paquete en el handler del consumidor', () => {
    const request = catalogHandlersV1.HandleAuditCompletedRequest.fromPartial({
      event: {
        metadata: { eventId: 'e1', producer: 'audit-service', occurredAt: new Date(0) },
        lotId: 'l1',
        verdict: auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED,
        score: 82,
      },
    });
    const decoded = catalogHandlersV1.HandleAuditCompletedRequest.decode(
      catalogHandlersV1.HandleAuditCompletedRequest.encode(request).finish(),
    );
    expect(decoded.event?.metadata?.eventId).toBe('e1');
    expect(decoded.event?.verdict).toBe(auditEventsV1.AuditVerdict.AUDIT_VERDICT_APPROVED);
  });

  it('distingue un opcional ausente de uno presente', () => {
    const empty = auctionV1.Auction.decode(auctionV1.Auction.encode(auctionV1.Auction.fromPartial({ id: 'a1' })).finish());
    const won = auctionV1.Auction.decode(
      auctionV1.Auction.encode(auctionV1.Auction.fromPartial({ id: 'a1', winnerId: 'u1' })).finish(),
    );
    expect(empty.winnerId).toBeUndefined();
    expect(won.winnerId).toBe('u1');
  });
});
