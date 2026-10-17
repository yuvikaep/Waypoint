import test from 'node:test';
import assert from 'node:assert/strict';
import { TrackingStore } from './tracking-store.mjs';
import { addMonths, couponProblem, planState, priceWithCoupon, renewalFrom } from './billing.mjs';

test('plan arithmetic: months land on the same day, early renewal keeps the days already bought', () => {
  const jan31 = Date.parse('2026-01-31T00:00:00Z');
  assert.equal(new Date(addMonths(jan31, 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(addMonths(jan31, 12)).toISOString().slice(0, 10), '2027-01-31');
  const now = Date.parse('2026-10-17T00:00:00Z'), expiry = Date.parse('2026-11-30T00:00:00Z');
  assert.equal(renewalFrom(expiry, now), expiry, 'renewing early extends from the current expiry');
  assert.equal(renewalFrom(Date.parse('2026-09-01T00:00:00Z'), now), now, 'an expired plan starts today');
  assert.equal(renewalFrom(null, now), now);
  assert.equal(planState({ planExpiresAt: null }, now).state, 'none');
  assert.equal(planState({ planExpiresAt: now - 1 }, now).state, 'expired');
  assert.equal(planState({ planExpiresAt: now + 10 * 86400000 }, now).state, 'due');
  assert.equal(planState({ planExpiresAt: now + 200 * 86400000 }, now).state, 'active');
});

test('a coupon never discounts more than the price, and rounds in the customer favour', () => {
  assert.deepEqual(priceWithCoupon(1000, null), { amount: 1000, discount: 0, payable: 1000 });
  assert.deepEqual(priceWithCoupon(999, { kind: 'percent', value: 20 }), { amount: 999, discount: 199, payable: 800 });
  assert.deepEqual(priceWithCoupon(500, { kind: 'amount', value: 900 }), { amount: 500, discount: 500, payable: 0 });
  const now = Date.now();
  assert.equal(couponProblem(null), 'This coupon code is not valid.');
  assert.match(couponProblem({ enabled: 0 }), /no longer active/);
  assert.match(couponProblem({ enabled: 1, expiresAt: now - 1 }, now), /expired/);
  assert.match(couponProblem({ enabled: 1, maxUses: 2, used: 2 }, now), /usage limit/);
  assert.equal(couponProblem({ enabled: 1, maxUses: 2, used: 1 }, now), null);
});

test('recording a payment extends the plan, counts the coupon and feeds the admin numbers', t => {
  let now = Date.parse('2026-10-17T06:00:00Z');
  const store = new TrackingStore(':memory:', { now: () => now }); t.after(() => store.close());
  const device = store.createDevice({ name: 'UP65 AB 1234', model: 'PT06', uniqueId: '356218606437323' }).device;
  assert.equal(store.planRows()[0].plan.state, 'none');

  store.saveCoupon({ code: 'diwali20', kind: 'percent', value: 20, maxUses: 1 });
  const first = store.renewDevice(device.id, { months: 12, amount: 2000, couponCode: 'DIWALI20' });
  assert.deepEqual([first.payment.amount, first.payment.discount, first.payment.payable], [2000, 400, 1600]);
  assert.equal(new Date(first.payment.periodTo).toISOString().slice(0, 10), '2027-10-17');
  assert.equal(store.coupon('DIWALI20').used, 1);
  // The same coupon again is refused once its single use is spent, and the plan is untouched.
  assert.throws(() => store.renewDevice(device.id, { months: 12, amount: 2000, couponCode: 'DIWALI20' }), /usage limit/);
  assert.equal(store.devicePayments(device.id).length, 1);

  // Renewing while the plan still runs extends from its expiry, not from today.
  now += 30 * 86400000;
  const second = store.renewDevice(device.id, { months: 12, amount: 2000 });
  assert.equal(new Date(second.payment.periodTo).toISOString().slice(0, 10), '2028-10-17');
  assert.equal(store.planRows()[0].plan.state, 'active');

  const billing = store.billing();
  assert.equal(billing.devices.total, 1);
  assert.equal(billing.devices.onboardedLastMonth, 1, 'the clock has moved into the next month');
  assert.equal(billing.revenue.thisMonth, 2000, 'only the second payment falls in this month');
  assert.equal(billing.revenue.lastMonth, 1600);
  assert.equal(billing.plans.active, 1);
  assert.deepEqual(billing.recentPayments.map(p => p.deviceName), ['UP65 AB 1234', 'UP65 AB 1234']);

  // A plan inside the next 30 days is due; past its date it is expired.
  now = second.payment.periodTo - 10 * 86400000;
  assert.equal(store.billing().plans.due, 1);
  now = second.payment.periodTo + 86400000;
  assert.equal(store.billing().plans.expired, 1);
  assert.equal(store.billing().renewals[0].name, 'UP65 AB 1234');
});

test('coupon and renewal input is checked before anything is stored', t => {
  const store = new TrackingStore(':memory:'); t.after(() => store.close());
  const device = store.createDevice({ name: 'TEST', model: 'PT06', uniqueId: '356218606437324' }).device;
  assert.throws(() => store.saveCoupon({ code: 'ab', kind: 'percent', value: 10 }), /3-24/);
  assert.throws(() => store.saveCoupon({ code: 'TOOMUCH', kind: 'percent', value: 95 }), /at most 90/);
  assert.throws(() => store.renewDevice(device.id, { months: 7, amount: 100 }), /Plan length/);
  assert.throws(() => store.renewDevice(device.id, { months: 12, amount: -5 }), /rupees/);
  assert.throws(() => store.quoteCoupon('NOPE', 100), /not valid/);
  assert.equal(store.devicePayments(device.id).length, 0);
  assert.equal(store.planRows()[0].plan.state, 'none');
});
