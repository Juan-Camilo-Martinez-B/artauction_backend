import { BidLane } from '../src/modules/subastas/bid-lane';

describe('cola de pujas', () => {
  it('ejecuta la segunda oferta después de que la primera termina', async () => {
    const lane = new BidLane();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = lane.run('sala', async () => {
      order.push('entra');
      await gate;
      order.push('sale');
      return 'primera';
    });
    const second = lane.run('sala', async () => {
      order.push('segunda');
      return 'segunda';
    });
    release();
    await expect(first).resolves.toBe('primera');
    await expect(second).resolves.toBe('segunda');
    expect(order).toEqual(['entra', 'sale', 'segunda']);
  });
});
