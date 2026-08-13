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
