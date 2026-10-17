// Each GPS device carries its own yearly plan. Nothing is charged online: the customer pays outside
// the app and an admin records the payment here, which moves the device's expiry forward.
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
const DAY = 86400000;
export const PLAN_MONTHS = [1, 3, 6, 12, 24];
export const RENEWAL_SOON_DAYS = 30;

// Adding months to a timestamp, keeping the day of the month where it exists (31 Jan + 1 month = 28 Feb).
export function addMonths(at, months) {
  const d = new Date(at), day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
  return d.getTime();
}

// A renewal extends from the current expiry when the plan is still running, so paying early never
// loses the days already bought; an expired plan starts afresh from today.
export const renewalFrom = (expiresAt, now) => (expiresAt && expiresAt > now ? expiresAt : now);

export function planState(device, now = Date.now()) {
  const expiresAt = device?.planExpiresAt ?? null;
  if (!expiresAt) return { state: 'none', expiresAt: null, days: null };
  const days = Math.ceil((expiresAt - now) / DAY);
  return { state: expiresAt <= now ? 'expired' : days <= RENEWAL_SOON_DAYS ? 'due' : 'active', expiresAt, days };
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export function cleanCoupon(input = {}) {
  const code = String(input.code ?? '').trim().toUpperCase();
  if (!CODE.test(code)) bad('Coupon code must be 3-24 letters, digits, - or _.');
  const kind = String(input.kind ?? 'percent');
  if (!['percent', 'amount'].includes(kind)) bad('Discount must be a percentage or a rupee amount.');
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1) bad('Enter the discount value.');
  if (kind === 'percent' && value > 90) bad('A percentage discount can be at most 90%.');
  if (kind === 'amount' && value > 1000000) bad('A rupee discount can be at most 1000000.');
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === '' ? null : Number(input.expiresAt);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) bad('Enter a valid coupon end date.');
  const maxUses = input.maxUses === undefined || input.maxUses === null || input.maxUses === '' ? null : Number(input.maxUses);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000)) bad('Usage limit must be 1-100000.');
  const note = String(input.note ?? '').trim().slice(0, 200);
  return { code, kind, value, expiresAt, maxUses, note };
}

// Why a coupon cannot be used, or null when it can. Reasons are shown to the customer as they are.
export function couponProblem(coupon, now = Date.now()) {
  if (!coupon) return 'This coupon code is not valid.';
  if (!Number(coupon.enabled ?? 1)) return 'This coupon is no longer active.';
  if (coupon.expiresAt && coupon.expiresAt <= now) return 'This coupon has expired.';
  if (coupon.maxUses !== null && coupon.maxUses !== undefined && Number(coupon.used ?? 0) >= Number(coupon.maxUses)) return 'This coupon has reached its usage limit.';
  return null;
}

// Rupees, never fractions of one: a percentage is rounded down so the customer is never charged more.
export function priceWithCoupon(amount, coupon) {
  const base = Number(amount);
  if (!Number.isInteger(base) || base < 0 || base > 10000000) bad('Enter the amount in rupees.');
  if (!coupon) return { amount: base, discount: 0, payable: base };
  const discount = Math.min(base, coupon.kind === 'percent' ? Math.floor(base * Number(coupon.value) / 100) : Number(coupon.value));
  return { amount: base, discount, payable: base - discount };
}

export function cleanRenewal(input = {}) {
  const months = Number(input.months ?? 12);
  if (!PLAN_MONTHS.includes(months)) bad(`Plan length must be one of ${PLAN_MONTHS.join(', ')} months.`);
  const amount = Number(input.amount ?? 0);
  if (!Number.isInteger(amount) || amount < 0 || amount > 10000000) bad('Enter the amount collected, in rupees.');
  const note = String(input.note ?? '').trim().slice(0, 200);
  const code = input.couponCode ? String(input.couponCode).trim().toUpperCase() : null;
  return { months, amount, note, couponCode: code };
}
