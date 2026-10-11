import {
  amountTakenMessage,
  canWithdraw,
  durationMinutes,
  holdIncrease,
  incrementCoins,
  openingCoins,
  saleDescription,
  scheduleWindow,
  WITHDRAW_LEAD_MS,
} from '../src/modules/subastas/auction-policy';

describe('contrato de subasta', () => {
  const now = new Date('2026-10-11T12:00:00.000Z');

  it('deja la duración y el precio inicial en manos de la obra', () => {
    expect(durationMinutes(40)).toBe(30);
    expect(durationMinutes(100)).toBe(180);
    expect(openingCoins(2400, 3800)).toBe(3100);
    expect(openingCoins(10, 20)).toBe(50);
    expect(incrementCoins(3100)).toBe(155);
    expect(incrementCoins(50)).toBe(10);
    expect(saleDescription('Costa', '  Óleo   firme. ')).toBe('Costa. Óleo firme.');
  });

  it('sortea una ventana futura y nunca una fecha pasada', () => {
    const early = scheduleWindow(now, 30, () => 0);
    const late = scheduleWindow(now, 180, () => 0.999999);
    expect(early.startsAt.getTime()).toBeGreaterThan(now.getTime());
    expect(early.endsAt.getTime() - early.startsAt.getTime()).toBe(30 * 60_000);
    expect(late.startsAt.getTime()).toBeGreaterThan(early.startsAt.getTime());
    expect(late.endsAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('retiene solo el aumento y exige cuatro minutos para salir', () => {
    expect(holdIncrease(0, 250)).toBe(250);
    expect(holdIncrease(250, 320)).toBe(70);
    expect(canWithdraw(now, new Date(now.getTime() + WITHDRAW_LEAD_MS))).toBe(true);
    expect(canWithdraw(now, new Date(now.getTime() + WITHDRAW_LEAD_MS - 1))).toBe(false);
    expect(amountTakenMessage(200_000)).toBe('La oferta de 2000 ya fue publicada por otro usuario.');
  });
});
