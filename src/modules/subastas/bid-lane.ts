export class BidLane {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(auctionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(auctionId) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.tails.set(
      auctionId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}
