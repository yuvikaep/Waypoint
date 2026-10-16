import webpush from 'web-push';
import { fail } from './tracking-store.mjs';

// Phone notifications through the browser's own push service (Web Push). Free, no account:
// the keys are generated here once and kept in the database (or GPS_VAPID_PUBLIC/PRIVATE).
// Alerts are pushed by whichever request sees them first, so it works on Vercel without a timer.

// Only the browsers' push services, so a stored endpoint can never point the server elsewhere.
const PUSH_HOST = /^(fcm\.googleapis\.com|android\.googleapis\.com|([\w-]+\.)*push\.services\.mozilla\.com|([\w-]+\.)*notify\.windows\.com|web\.push\.apple\.com|([\w-]+\.)*push\.apple\.com)$/;
export const CATEGORIES = ['driver', 'sos', 'ignition', 'geofence', 'speed', 'driving', 'connection', 'tracker'];
// Same grouping as the app's Settings (src/customer/notify.ts).
export const categoryOf = type => type.startsWith('share_') ? 'driver' : type === 'sos' || type === 'parking_lock' ? 'sos'
  : type === 'harsh_brake' || type === 'harsh' ? 'driving' : type === 'ignition_on' || type === 'ignition_off' ? 'ignition'
  : type === 'enter' || type === 'exit' ? 'geofence' : type === 'speed' ? 'speed' : type === 'offline' || type === 'online' ? 'connection' : 'tracker';
const URGENT = new Set(['sos', 'parking_lock', 'harsh_brake', 'speed']);

export function cleanSubscription(body) {
  const sub = body?.subscription;
  let url;
  try { url = new URL(String(sub?.endpoint || '')); } catch { fail(400, 'Invalid push subscription.'); }
  if (url.protocol !== 'https:' || !PUSH_HOST.test(url.hostname) || url.href.length > 1000) fail(400, 'Unsupported push service.');
  const b64 = v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,200}={0,2}$/.test(v);
  if (!b64(sub.keys?.p256dh) || !b64(sub.keys?.auth)) fail(400, 'Invalid push subscription keys.');
  const lang = ['en', 'hi', 'hg'].includes(body.lang) ? body.lang : 'en';
  const categories = Array.isArray(body.categories) ? CATEGORIES.filter(c => body.categories.includes(c)) : CATEGORIES;
  return { endpoint: url.href, p256dh: sub.keys.p256dh, auth: sub.keys.auth, lang, categories: categories.join(',') };
}

// Title and line for the lock screen, in the language the phone chose when it subscribed.
const TITLES = {
  parking_lock: ['Parking lock alert', 'पार्किंग लॉक अलर्ट', 'Parking lock alert'],
  sos: ['SOS emergency', 'SOS इमरजेंसी', 'SOS emergency'],
  speed: ['Overspeed', 'ओवरस्पीड', 'Overspeed'],
  harsh_brake: ['Hard braking', 'अचानक ब्रेक', 'Achanak brake'],
  harsh: ['Harsh driving', 'खराब ड्राइविंग', 'Kharab driving'],
  ignition_on: ['Vehicle started', 'गाड़ी चालू हुई', 'Gaadi chalu hui'],
  ignition_off: ['Engine off', 'इंजन बंद', 'Engine band'],
  enter: ['Entered place', 'जगह में पहुँची', 'Jagah me pahunchi'],
  exit: ['Left place', 'जगह से निकली', 'Jagah se nikli'],
  offline: ['Signal lost', 'सिग्नल चला गया', 'Signal chala gaya'],
  online: ['Signal restored', 'सिग्नल वापस आया', 'Signal wapas aaya'],
  share_stopped: ['Driver location off', 'ड्राइवर की लोकेशन बंद', 'Driver ki location band'],
  share_expired: ['Driver link expired', 'ड्राइवर लिंक ख़त्म', 'Driver link khatam'],
  share_resumed: ['Driver sharing again', 'ड्राइवर फिर से शेयर कर रहा है', 'Driver phir se share kar raha hai'],
  relay: ['Engine lock', 'इंजन लॉक', 'Engine lock'],
};
const LINES = {
  parking_lock: m => /engine/.test(m) ? ['Locked vehicle: engine started', 'लॉक की हुई गाड़ी का इंजन चालू हुआ', 'Lock ki hui gaadi ka engine chalu hua']
    : ['Locked vehicle is moving', 'लॉक की हुई गाड़ी चल रही है', 'Lock ki hui gaadi chal rahi hai'],
  sos: () => ['Emergency! SOS pressed', 'इमरजेंसी! SOS दबाया गया', 'Emergency! SOS dabaya gaya'],
};
export function pushText(alert, lang = 'en') {
  const n = { en: 0, hi: 1, hg: 2 }[lang] ?? 0, m = String(alert.message || '');
  const title = `${(TITLES[alert.type] || ['Vehicle alarm', 'गाड़ी अलार्म', 'Gaadi alarm'])[n]} · ${alert.deviceName}`;
  const line = LINES[alert.type]?.(m)?.[n];
  const detail = m.replace(/^Demo: /, '');
  return { title, body: line ? `${line}. ${detail}` : detail, urgent: URGENT.has(alert.type) };
}

export async function vapidKeys(store) {
  if (process.env.GPS_VAPID_PUBLIC && process.env.GPS_VAPID_PRIVATE) return { publicKey: process.env.GPS_VAPID_PUBLIC, privateKey: process.env.GPS_VAPID_PRIVATE };
  let keys = await store.setting('vapid');
  if (!keys) { await store.setSettingOnce('vapid', JSON.stringify(webpush.generateVAPIDKeys())); keys = await store.setting('vapid'); }
  return JSON.parse(keys);
}

// Sends every alert not pushed yet to the phones of that fleet that want its category.
export async function deliverPushes(store, { origin = 'https://waypoint.app', send = webpush.sendNotification.bind(webpush) } = {}) {
  const alerts = await store.claimUnpushed();
  if (!alerts.length) return 0;
  const keys = await vapidKeys(store), vapid = { subject: origin.startsWith('https://') ? origin : 'https://waypoint.app', ...keys };
  const byTenant = new Map();
  for (const a of alerts) { if (!byTenant.has(a.tenantId)) byTenant.set(a.tenantId, await store.pushSubs(a.tenantId)); }
  const jobs = [];
  for (const a of alerts) for (const sub of byTenant.get(a.tenantId)) {
    if (!String(sub.categories).split(',').includes(categoryOf(a.type))) continue;
    const text = pushText(a, sub.lang);
    const payload = JSON.stringify({ ...text, tag: a.id, url: '/?live=1' });
    jobs.push(send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
      { TTL: 3600, urgency: text.urgent ? 'high' : 'normal', timeout: 5000, vapidDetails: vapid })
      .catch(async e => { if (e.statusCode === 404 || e.statusCode === 410) await store.deletePushSub(sub.endpoint); else console.warn('Push failed:', e.statusCode || e.message); }));
  }
  await Promise.all(jobs);
  return jobs.length;
}
