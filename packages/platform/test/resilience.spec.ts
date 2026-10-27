import { CircuitBreaker } from '../src/resilience/circuit-breaker';
import { backoffDelay, retry } from '../src/resilience/retry';

describe('CircuitBreaker', () => {
  it('abre tras el umbral y deja pasar una prueba al terminar el enfriamiento', () => {
    const breaker = new CircuitBreaker('ia', 3, 30_000);
    breaker.recordFailure(0);
    breaker.recordFailure(1);
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure(2);
    expect(() => {
      breaker.assertClosed(2_100);
    }).toThrow(/abierto/);
    breaker.assertClosed(32_000);
    expect(breaker.isOpen).toBe(false);
  });

  it('vuelve a abrir con un solo fallo en estado semiabierto', () => {
    const breaker = new CircuitBreaker('ia', 3, 1_000);
    for (const now of [0, 1, 2]) {
      breaker.recordFailure(now);
    }
    breaker.assertClosed(2_000);
    breaker.recordFailure(2_001);
    expect(breaker.isOpen).toBe(true);
  });

  it('execute registra exito y fallo', async () => {
    const breaker = new CircuitBreaker('ia', 1, 1_000);
    await expect(breaker.execute(() => Promise.resolve('ok'), () => 0)).resolves.toBe('ok');
    await expect(breaker.execute(() => Promise.reject(new Error('x')), () => 0)).rejects.toThrow('x');
    await expect(breaker.execute(() => Promise.resolve('ok'), () => 10)).rejects.toThrow(/abierto/);
  });
});

describe('retry', () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it('reintenta hasta tener exito', async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('temporal')) : Promise.resolve('ok');
      },
      { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('no reintenta un error no recuperable', async () => {
    let calls = 0;
    await expect(
      retry(
        () => {
          calls += 1;
          return Promise.reject(new Error('definitivo'));
        },
        { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep: noSleep, shouldRetry: () => false },
      ),
    ).rejects.toThrow('definitivo');
    expect(calls).toBe(1);
  });

  it('acota el backoff al maximo', () => {
    expect(backoffDelay(10, { baseDelayMs: 100, maxDelayMs: 2_000 }, () => 0.999)).toBeLessThan(2_000);
    expect(backoffDelay(0, { baseDelayMs: 100, maxDelayMs: 2_000 }, () => 0.5)).toBe(50);
  });
});
