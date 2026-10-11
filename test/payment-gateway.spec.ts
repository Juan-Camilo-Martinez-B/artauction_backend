import { DECLINED_CARD, inspectCard, luhnOk } from '../src/modules/bolsillo/payment-gateway';

describe('pasarela simulada', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');
  const valid = {
    number: '4242424242424242',
    expMonth: 12,
    expYear: 2030,
    cvv: '123',
  };

  it('acepta una tarjeta inventada que pasa Luhn y rechaza la de prueba', () => {
    expect(luhnOk('4242424242424242')).toBe(true);
    expect(inspectCard(valid, now)).toMatchObject({ accepted: true, last4: '4242', brand: 'visa' });
    expect(inspectCard({ ...valid, number: DECLINED_CARD }, now).accepted).toBe(false);
    expect(inspectCard({ ...valid, expYear: 2020 }, now).accepted).toBe(false);
    expect(inspectCard({ ...valid, cvv: '12' }, now).accepted).toBe(false);
  });
});
