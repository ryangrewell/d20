/**
 * The single coordinate-transform module for the tabletop.
 *
 * "Map" coordinates are native, untransformed image pixels. Everything persisted
 * (tokens, fog, calibration endpoints, cursors) uses map coordinates. "Screen"
 * coordinates are CSS pixels relative to the canvas element. Zoom and pan only
 * change the camera; they never change scale.
 */
import { toMeters, type DistanceUnit } from '../units';

export type Point = { x: number; y: number };

export type Camera = {
  /** Map coordinate displayed at the screen origin (top-left). */
  x: number;
  y: number;
  /** Screen pixels per map pixel. */
  zoom: number;
};

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 16;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function screenToMap(p: Point, cam: Camera): Point {
  return { x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom };
}

export function mapToScreen(p: Point, cam: Camera): Point {
  return { x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom };
}

/** Zoom by `factor` keeping the map point under `screenAnchor` fixed on screen. */
export function zoomAt(cam: Camera, screenAnchor: Point, factor: number): Camera {
  const zoom = clampZoom(cam.zoom * factor);
  const anchor = screenToMap(screenAnchor, cam);
  return { zoom, x: anchor.x - screenAnchor.x / zoom, y: anchor.y - screenAnchor.y / zoom };
}

export function panBy(cam: Camera, screenDx: number, screenDy: number): Camera {
  return { ...cam, x: cam.x - screenDx / cam.zoom, y: cam.y - screenDy / cam.zoom };
}

/** Camera that fits a map of the given size into a viewport, centred, with padding. */
export function fitCamera(mapW: number, mapH: number, viewW: number, viewH: number, padding = 24): Camera {
  const availW = Math.max(1, viewW - padding * 2);
  const availH = Math.max(1, viewH - padding * 2);
  const zoom = clampZoom(Math.min(availW / mapW, availH / mapH));
  return { zoom, x: mapW / 2 - viewW / 2 / zoom, y: mapH / 2 - viewH / 2 / zoom };
}

/** Camera centred on a map point at a given zoom (used by "focus everyone here"). */
export function centerOn(p: Point, zoom: number, viewW: number, viewH: number): Camera {
  const z = clampZoom(zoom);
  return { zoom: z, x: p.x - viewW / 2 / z, y: p.y - viewH / 2 / z };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// ---------------------------------------------------------------- calibration

export type ScaleCalibration = {
  a: Point;
  b: Point;
  enteredDistance: number;
  enteredUnit: DistanceUnit;
  pixelsPerMeter: number;
};

export class CalibrationError extends Error {}

/** Two-point uniform-scale calibration. Inputs are native image pixels. */
export function computeCalibration(a: Point, b: Point, enteredDistance: number, enteredUnit: DistanceUnit): ScaleCalibration {
  if (!Number.isFinite(enteredDistance) || enteredDistance <= 0) {
    throw new CalibrationError('Enter a known distance greater than zero.');
  }
  const referencePixels = distance(a, b);
  if (!Number.isFinite(referencePixels) || referencePixels < 1) {
    throw new CalibrationError('Draw a longer reference line between two distinct points.');
  }
  const referenceMeters = toMeters(enteredDistance, enteredUnit);
  return { a, b, enteredDistance, enteredUnit, pixelsPerMeter: referencePixels / referenceMeters };
}

export function pixelsToDistance(pixelDistance: number, pixelsPerMeter: number): number {
  return pixelDistance / pixelsPerMeter;
}

export function distanceToPixels(meters: number, pixelsPerMeter: number): number {
  return meters * pixelsPerMeter;
}

/** Normalise map coords to 0..1 (used for cursor packets so bounds checks are trivial). */
export function normalize(p: Point, mapW: number, mapH: number): Point {
  return { x: p.x / mapW, y: p.y / mapH };
}

export function denormalize(p: Point, mapW: number, mapH: number): Point {
  return { x: p.x * mapW, y: p.y * mapH };
}
