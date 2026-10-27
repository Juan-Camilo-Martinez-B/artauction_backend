import { KeyedSerialQueue } from '../src/concurrency/keyed-serial-queue';

describe('KeyedSerialQueue', () => {
  it('ejecuta en orden de llegada las tareas de la misma clave', async () => {
    const queue = new KeyedSerialQueue();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run('sala', async () => {
      order.push('entra');
      await gate;
      order.push('sale');
      return 'primera';
    });
    const second = queue.run('sala', () => {
      order.push('segunda');
      return Promise.resolve('segunda');
    });
    release();
    await expect(first).resolves.toBe('primera');
    await expect(second).resolves.toBe('segunda');
    expect(order).toEqual(['entra', 'sale', 'segunda']);
  });

  it('sigue con la siguiente tarea aunque la anterior falle', async () => {
    const queue = new KeyedSerialQueue();
    const failed = queue.run('sala', () => Promise.reject(new Error('fallo')));
    const next = queue.run('sala', () => Promise.resolve('ok'));
    await expect(failed).rejects.toThrow('fallo');
    await expect(next).resolves.toBe('ok');
  });

  it('libera la clave cuando la cola queda vacia', async () => {
    const queue = new KeyedSerialQueue();
    await queue.run('sala', () => Promise.resolve(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.pendingKeys).toBe(0);
  });
});
