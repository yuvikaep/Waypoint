// Hand-written types for the movement rule the customer app shares with the server.
type Point = { latitude: number; longitude: number };
type Fix = Point & { speed: number };
export const MOVING_KMH: number;
export const MOVE_M: number;
export const ARRIVE_M: number;
export function movingAt(list: Fix[], k: number, distance: (a: Point, b: Point) => number): boolean;
export function runningAt(fixes: Fix[], i: number, distance: (a: Point, b: Point) => number): boolean;
