// Hand-written types for the run/stop rule the customer app shares with the server.
type Point = { latitude: number; longitude: number };
type TrackFix = Point & { recordedAt: number; speed: number; ignition?: number | null; valid?: number };
type Seg = { kind: 'run' | 'stop'; from: number; to: number; km: number; at: TrackFix; end: TrackFix; maxSpeed: number };
export function km(a: Point, b: Point): number;
export function metres(a: Point, b: Point): number;
export function trackOf(fixes: TrackFix[]): TrackFix[];
export function segmentsOf(track: TrackFix[], options?: { keepLast?: boolean; wired?: boolean }): Seg[];
export function standingSince(fixes: TrackFix[], options?: { wired?: boolean }): number | null;
