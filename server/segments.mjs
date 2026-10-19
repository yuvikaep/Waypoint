// Runs and stops of one vehicle, worked out once and used everywhere: the history timeline draws
// these, and the vehicle card reads its "stopped since" off the last of them, so a card and a
// timeline can never tell the owner two different things.
import { ARRIVE_M, MOVE_M, MOVING_KMH, runningAt } from './extra.mjs';

const STOP_MIN = 5 * 60000;     // a halt shorter than this is part of the drive, not a stop
const BLIP_MS = 2 * 60000;      // and a "run" this short inside a stop is the GPS, not a trip
const MAX_KMH = 150;            // a jump implying more than this is noise, not distance

export function km(a, b) {
  const r = Math.PI / 180, h = Math.sin((b.latitude - a.latitude) * r / 2) ** 2
    + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin((b.longitude - a.longitude) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
export const metres = (a, b) => km(a, b) * 1000;

// Fixes in any order, with the heartbeats a parked tracker sends as copies of its last fix thrown
// out: counted twice, a copy makes a standing vehicle look as if it travelled. Whoever asks for
// segments gets the same reading, because the sorting and the thinning happen here.
export function trackOf(fixes) {
  return fixes.filter(p => p.valid !== 0)
    .slice().sort((a, b) => a.recordedAt - b.recordedAt || (a.id ?? 0) - (b.id ?? 0))
    .filter((p, i, all) => !i || p.recordedAt !== all[i - 1].recordedAt
      || p.latitude !== all[i - 1].latitude || p.longitude !== all[i - 1].longitude);
}
// A stop that is still going on is kept whole however short it is so far, which is what the vehicle
// card asks for; the timeline, looking back over a finished day, folds a brief halt into the drive.
export function segmentsOf(fixes, { keepLast = false } = {}) {
  const track = trackOf(fixes), out = [];
  // An ignition wire: with one fitted, the engine has to be on for the vehicle to be running.
  const wired = track.some(q => q.ignition === 1);
  let cur = null;
  for (let n = 0; n < track.length; n++) {
    const p = track[n], prev = track[n - 1];
    const kind = runningAt(track, n, metres) && !(wired && p.ignition === 0) ? 'run' : 'stop';
    let step = 0;
    if (prev) {
      const dt = (p.recordedAt - prev.recordedAt) / 3600000, d = km(prev, p);
      if (dt > 0 && d / dt <= MAX_KMH && (kind === 'run' || prev.speed >= MOVING_KMH || d >= MOVE_M / 1000)) step = d;
    }
    if (!cur || cur.kind !== kind) {
      // The ground covered between two fixes belongs to the segment that ends it: the step that
      // starts a drive is part of that drive, not of the stop the vehicle has just left.
      if (cur) { cur.to = p.recordedAt; cur.end = p; }
      cur = { kind, from: p.recordedAt, to: p.recordedAt, km: 0, at: p, end: p, maxSpeed: p.speed };
      out.push(cur);
    }
    cur.to = p.recordedAt; cur.end = p; cur.km += step; cur.maxSpeed = Math.max(cur.maxSpeed, p.speed);
  }
  // A tracker standing still can throw its position a few hundred metres and bring it straight back.
  // That reads as a brief trip to nowhere: the vehicle is in the same place before and after it, so
  // it never went anywhere and the "run" is turned back into standing.
  for (let n = 0; n < out.length; n++) {
    const s = out[n], before = out[n - 1], after = out[n + 1];
    if (s.kind !== 'run' || s.to - s.from >= BLIP_MS || !before || before.kind !== 'stop') continue;
    // Where it stood before and where it stands after; a segment's end is already the next
    // segment's first fix, so the starting points are what tell us the place has not changed.
    if (metres(before.at, after ? after.at : s.end) <= ARRIVE_M) s.kind = 'stop';
  }
  // A short "run" inside a stop is the GPS wandering, and a short halt inside a drive is a traffic
  // light: neither is worth its own line, so both are folded into the segment they interrupted.
  const merged = [];
  for (const s of out) {
    const last = merged.at(-1);
    if (s.kind === 'run' && last?.kind === 'stop' && s.to - s.from < BLIP_MS && s.km < MOVE_M / 1000) { last.to = s.to; last.end = s.end; continue; }
    if (s.kind === 'stop' && s.to - s.from < STOP_MIN && last && !(keepLast && s === out.at(-1))) { last.to = s.to; last.end = s.end; last.km += s.km; continue; }
    if (last && last.kind === s.kind) { last.to = s.to; last.end = s.end; last.km += s.km; last.maxSpeed = Math.max(last.maxSpeed, s.maxSpeed); continue; }
    merged.push({ ...s });
  }
  return merged;
}

// When the vehicle's current stop began, from fixes given newest first. Null when it is not stopped
// in these fixes at all.
export function standingSince(fixes) {
  const last = segmentsOf(fixes, { keepLast: true }).at(-1);
  return last?.kind === 'stop' ? last.from : null;
}
