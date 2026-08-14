// Point-in-polygon helpers shared by the data build and the smoke tests.
// The campus boundary is any number of polygons — the main parcel plus any
// extra ones (for example a hostel block across the road) — and a point is
// on campus when it falls inside at least one of them.

/** Ray-casting point-in-ring test. Ring is a closed array of [lon, lat]. */
export function pointInRing(lon, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1]
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** The outer rings of every Polygon feature in a FeatureCollection. */
export function ringsOf(features) {
  return (features ?? [])
    .filter((f) => f.geometry?.type === 'Polygon')
    .map((f) => f.geometry.coordinates[0])
}

/** True when the point falls inside at least one of the given rings. */
export function inAnyRing(lon, lat, rings) {
  return rings.some((ring) => pointInRing(lon, lat, ring))
}

/**
 * Area-weighted centroid of a FeatureCollection of polygons, as [lon, lat].
 * Holes subtract (their rings carry the opposite winding), so the result is
 * the true centre of the parcels, not of their bounding box. Falls back to
 * [0, 0] when there is nothing to measure.
 */
export function centroidOf(features) {
  let a = 0, cx = 0, cy = 0
  for (const f of features ?? []) {
    const g = f.geometry
    if (!g || g.type !== 'Polygon') continue
    for (const ring of g.coordinates) {
      for (let i = 0; i < ring.length - 1; i++) {
        const x1 = ring[i][0], y1 = ring[i][1]
        const x2 = ring[i + 1][0], y2 = ring[i + 1][1]
        const cross = x1 * y2 - x2 * y1
        a += cross
        cx += (x1 + x2) * cross
        cy += (y1 + y2) * cross
      }
    }
  }
  if (a === 0) return [0, 0]
  return [cx / (3 * a), cy / (3 * a)]
}
