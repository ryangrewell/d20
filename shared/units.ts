export const DISTANCE_UNITS = ['ft', 'yd', 'mi', 'm', 'km'] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/** Exact conversion factors to meters (international foot/yard/mile). */
export const METERS_PER_UNIT: Record<DistanceUnit, number> = {
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
  m: 1,
  km: 1000,
};

export const UNIT_LABELS: Record<DistanceUnit, { singular: string; plural: string }> = {
  ft: { singular: 'foot', plural: 'feet' },
  yd: { singular: 'yard', plural: 'yards' },
  mi: { singular: 'mile', plural: 'miles' },
  m: { singular: 'meter', plural: 'meters' },
  km: { singular: 'kilometer', plural: 'kilometers' },
};

export function toMeters(value: number, unit: DistanceUnit): number {
  return value * METERS_PER_UNIT[unit];
}

export function fromMeters(meters: number, unit: DistanceUnit): number {
  return meters / METERS_PER_UNIT[unit];
}

export function convert(value: number, from: DistanceUnit, to: DistanceUnit): number {
  return fromMeters(toMeters(value, from), to);
}

/** Formats a distance with sensible precision, e.g. "52.5 ft", "0.38 mi". */
export function formatDistance(meters: number, unit: DistanceUnit): string {
  const v = fromMeters(meters, unit);
  const abs = Math.abs(v);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${unit}`;
}
