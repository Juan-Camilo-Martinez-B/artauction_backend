import { CircuitBreaker } from '../src/infra/ai/circuit-breaker';

describe('circuit breaker', () => {
  it('abre tras tres fallos y vuelve a cerrar al pasar el enfriamiento', () => {
    const breaker = new CircuitBreaker(3, 30_000);
    breaker.recordFailure(0);
    breaker.recordFailure(1);
    expect(breaker.isOpen).toBe(false);
    breaker.recordFailure(2);
    expect(() => {
      breaker.assertClosed(2_100);
    }).toThrow(/abierto/);
    breaker.assertClosed(32_000);
    expect(breaker.isOpen).toBe(false);
    breaker.recordSuccess();
    breaker.assertClosed(32_001);
  });
});
