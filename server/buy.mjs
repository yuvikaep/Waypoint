// "Buy GPS" enquiries from customers. The admin sees them in the console and calls back; nothing is
// sold or charged online.
export const GPS_PRODUCTS = ['wired', 'portable', 'phone'];
export const REQUEST_STATUS = ['new', 'contacted', 'done'];
const bad = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function cleanGpsRequest(body = {}) {
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 100) bad('Enter your name.');
  const phone = String(body.phone ?? '').replace(/[\s-]/g, '');
  if (!/^\+?\d{10,13}$/.test(phone)) bad('Enter a 10-digit mobile number.');
  const vehicles = Number(body.vehicles ?? 1);
  if (!Number.isInteger(vehicles) || vehicles < 1 || vehicles > 1000) bad('Number of vehicles must be 1-1000.');
  const product = String(body.product ?? 'wired');
  if (!GPS_PRODUCTS.includes(product)) bad('Choose a GPS type.');
  const note = String(body.note ?? '').trim().slice(0, 500);
  return { name, phone, vehicles, product, note };
}
