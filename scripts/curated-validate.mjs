// Shared validation for the curated GeoJSON files: the whitelist of file
// names the dev server serves and saves, and the geometry-type rule per file.
// vite.config.ts (dev middleware) and scripts/smoke.mjs both import this so
// the server and the tests can never disagree about what is legal.

export const GEOMETRY_RULES = {
  boundary: 'Polygon',
  buildings: 'Polygon',
  paths: 'LineString',
  indoor: 'Polygon',
  pois: 'Point',
}

export const CURATED_KEYS = Object.keys(GEOMETRY_RULES)

/** 'buildings.geojson' -> 'buildings'; anything else -> null. */
export function curatedKey(fileName) {
  if (typeof fileName !== 'string') return null
  const m = /^([a-z]+)\.geojson$/.exec(fileName)
  return m && GEOMETRY_RULES[m[1]] ? m[1] : null
}

/**
 * Validate a parsed save payload for one curated file. The payload is the
 * full FeatureCollection object — top-level props like `_readme`, `_source`
 * and `_sample` are legal and preserved. Only the type/features/geometry
 * structure is checked.
 *
 * Returns { ok: true } or { ok: false, error }.
 */
export function validateFeatureCollection(data, key) {
  const want = GEOMETRY_RULES[key]
  if (!want) return { ok: false, error: `unknown curated file "${key}"` }
  if (!data || typeof data !== 'object' || data.type !== 'FeatureCollection') {
    return { ok: false, error: 'payload.data must be a GeoJSON FeatureCollection' }
  }
  if (!Array.isArray(data.features)) {
    return { ok: false, error: 'FeatureCollection has no features array' }
  }
  for (let i = 0; i < data.features.length; i++) {
    const f = data.features[i]
    if (!f || f.type !== 'Feature' || !f.geometry || typeof f.geometry.type !== 'string') {
      return { ok: false, error: `feature ${i} is not a valid GeoJSON feature` }
    }
    if (f.geometry.type !== want) {
      return { ok: false, error: `feature ${i} is ${f.geometry.type}, expected ${want} in ${key}.geojson` }
    }
  }
  return { ok: true }
}
