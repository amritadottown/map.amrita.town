import type { StyleSpecification } from 'maplibre-gl'
import type { Campus, GeoData } from '../types'

/**
 * The whole basemap is drawn from our own curated GeoJSON — no tile server,
 * no API key and no external request. The campus is small enough that the
 * entire extract fits in a few hundred kB, so the map renders from one static
 * fetch. Label glyphs are served from public/font too.
 *
 * Multi-floor rendering lives in the `floor` source. The app loads one active
 * floor's rooms into it; each room feature carries a precomputed `fill` colour
 * and `poi`/`focus` flags, so a POI room reads brighter than its dimmer
 * neighbours and the focused room brightest of all — there are no dot pins
 * indoors.
 *
 * The palette follows the amrita.town.css brand: paper-coloured grounds with
 * the canonical six tokens, and the accent (#ae0c3e light / #e0527a dark) is
 * the only emphasis colour — routes, focus rings and the active floor outline
 * all use it. Category colours come from the curated data, not from here.
 */
const PALETTE = {
  dark: {
    bg: '#181818',          // --base
    campus: '#141414',      // the ground inside the wall, a shade of base
    building: '#1d1d1d',
    buildingEdge: '#333333',// --secondary on base
    named: '#232323',
    road: '#3a3a3a',
    roadCase: '#1f1f1f',
    path: '#2f2f2f',
    steps: '#454545',
    boundary: '#3a3a3a',
    label: '#d9d9d9',       // --text
    labelHalo: '#181818',   // --base
    dotStroke: '#181818',
    routeHalo: '#181818',
    route: '#e0527a',       // --accent
    focus: '#e0527a',       // --accent
    dim: '#0e0e0e',
    // Translucent wash over everything outside the campus wall. Dark on dark
    // is subtle (the background is already near-black); the effect shows on
    // light mode and over the satellite basemap.
    outside: 'rgba(0, 0, 0, 0.5)',
    floorBase: '#262626',
    floorEdge: '#3a3a3a',
    floorLabel: '#c9c9c9',
    floorLabelHalo: '#181818',
    activeOutline: '#e0527a',
  },
  light: {
    bg: '#e9e3d5',          // the world outside the wall, a deeper paper
    campus: '#faf7f0',      // --base: the campus ground
    building: '#f1ece1',
    buildingEdge: '#cfc8b8',// --secondary on base
    named: '#e7e0d0',
    road: '#ffffff',
    roadCase: '#d6cfbd',
    path: '#fffdf6',
    steps: '#c9c1ae',
    boundary: '#b7af9d',
    label: '#000000d0',     // --text
    labelHalo: '#faf7f0',   // --base
    dotStroke: '#faf7f0',
    routeHalo: '#faf7f0',
    route: '#ae0c3e',       // --accent
    focus: '#ae0c3e',       // --accent
    dim: '#e9e2d2',
    outside: 'rgba(0, 0, 0, 0.4)',
    floorBase: '#e3dbc9',
    floorEdge: '#c4bba6',
    floorLabel: '#5a5445',
    floorLabelHalo: '#faf7f0',
    activeOutline: '#ae0c3e',
  },
} as const

/** Must match a directory under public/font. */
export const FONT = 'Noto Sans Regular'

export function buildStyle(
  geo: GeoData,
  campus: Campus,
  theme: 'light' | 'dark' = 'dark',
  base = '/',
): StyleSpecification {
  const C = PALETTE[theme]

  const src = (data: GeoJSON.FeatureCollection) => ({ type: 'geojson' as const, data })
  const empty = { type: 'FeatureCollection' as const, features: [] }

  return {
    version: 8,
    glyphs: `${base}font/{fontstack}/{range}.pbf`,
    sources: {
      boundary: src(geo.boundary),
      buildings: src(geo.buildings),
      paths: src(geo.paths),
      floor: { type: 'geojson', data: empty },
      pois: { type: 'geojson', data: empty },
      route: { type: 'geojson', data: empty },
      // The world outside the campus wall, one polygon with the wall as a
      // hole — the spotlight that dims everything off campus.
      outside: src(outsideFC(geo.boundary)),
      // Optional satellite basemap (ESRI World Imagery, no API key). Only
      // loaded when the user turns the Satellite toggle on; off by default so
      // the map stays fully offline and self-drawn. Attribution is shown in
      // the footer while it is active.
      sat: {
        type: 'raster',
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        tileSize: 256,
        maxzoom: 19,
        attribution: 'Imagery: Esri, Maxar, Earthstar Geographics',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': C.bg } },

      // Raster must sit above the background but below every curated layer.
      // Hidden by default; the app flips it when Satellite is on.
      {
        id: 'sat', type: 'raster', source: 'sat',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 1 },
      },

      { id: 'campus', type: 'fill', source: 'boundary', paint: { 'fill-color': C.campus } },
      {
        id: 'campus-edge', type: 'line', source: 'boundary',
        paint: { 'line-color': C.boundary, 'line-width': 1.2, 'line-dasharray': [3, 2] },
      },

      // Roads get a casing so junctions read cleanly at low zoom.
      {
        id: 'road-case', type: 'line', source: 'paths',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.roadCase,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 2, 16, 7, 19, 22],
          'line-opacity': 0.45,
        },
      },
      {
        id: 'road', type: 'line', source: 'paths',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1, 16, 4.5, 19, 16],
          'line-opacity': 0.35,
        },
      },
      {
        id: 'path', type: 'line', source: 'paths',
        filter: ['==', ['get', 'kind'], 'path'],
        minzoom: 14,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.path,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 14, 0.6, 17, 2, 19, 5],
          'line-opacity': 0.35,
        },
      },
      {
        id: 'path-steps', type: 'line', source: 'paths',
        filter: ['==', ['get', 'kind'], 'steps'],
        minzoom: 15,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': C.steps,
          'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 15, 1.5, 19, 6],
          'line-dasharray': [1, 1],
          'line-opacity': 0.35,
        },
      },

      // Everything outside the campus wall sits under this translucent veil —
      // the flat background, satellite imagery and the surrounding roads — so
      // the campus reads as the bright spot of the map. It sits above the
      // ground and road layers but below every layer that only draws inside
      // the campus (buildings, floors, POIs, routes), so nothing on campus is
      // ever dimmed. The wall itself is the hole in the polygon.
      {
        id: 'outside-dim', type: 'fill', source: 'outside',
        paint: { 'fill-color': C.outside },
      },

      {
        id: 'building', type: 'fill', source: 'buildings',
        paint: {
          'fill-color': ['case', ['!=', ['get', 'name'], ''], C.named, C.building],
          'fill-outline-color': C.buildingEdge,
        },
      },
      {
        id: 'building-top', type: 'line', source: 'buildings',
        minzoom: 16,
        paint: { 'line-color': C.buildingEdge, 'line-width': 0.7 },
      },
      // Category tint for buildings that are themselves a POI category.
      {
        id: 'building-cat', type: 'fill', source: 'buildings',
        filter: ['all', ['!=', ['get', 'cat'], ''], ['in', ['get', 'cat'], ['literal', []]]],
        paint: { 'fill-color': catColour(campus), 'fill-opacity': theme === 'dark' ? 0.16 : 0.28 },
      },

      // While a floor is open, every building except the active one is dimmed
      // by this translucent overlay. Opacity is 0 until the app opens a floor.
      {
        id: 'building-dim', type: 'fill', source: 'buildings',
        filter: ['!=', ['get', 'id'], ''],
        paint: { 'fill-color': C.dim, 'fill-opacity': 0 },
      },
      // The active building's footprint outline, visible only while open.
      {
        id: 'building-active', type: 'line', source: 'buildings',
        filter: ['==', ['get', 'id'], ''],
        paint: { 'line-color': C.activeOutline, 'line-width': 1.6 },
      },

      // The open floor's rooms. `fill` is precomputed per feature by the app;
      // poi rooms are brighter, the focused room brightest, the rest dim.
      {
        id: 'floor-fill', type: 'fill', source: 'floor',
        paint: {
          'fill-color': ['get', 'fill'],
          'fill-opacity': [
            'case',
            ['==', ['get', 'focus'], 1], 0.95,
            ['==', ['get', 'poi'], 1], 0.85,
            0.5,
          ],
        },
      },
      {
        id: 'floor-line', type: 'line', source: 'floor',
        minzoom: 16,
        paint: { 'line-color': C.floorEdge, 'line-width': 0.7 },
      },
      {
        id: 'floor-label', type: 'symbol', source: 'floor',
        minzoom: 16.5,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': [FONT],
          'text-size': ['interpolate', ['linear'], ['zoom'], 16.5, 9.5, 19.5, 12.5],
          'text-offset': [0, 0],
          'text-anchor': 'center',
          'text-max-width': 9,
          'text-optional': true,
          'text-padding': 3,
          'symbol-sort-key': ['case', ['==', ['get', 'kind'], 'room'], 0,
                                      ['==', ['get', 'kind'], 'corridor'], 2, 1],
        },
        paint: {
          'text-color': C.floorLabel,
          'text-halo-color': C.floorLabelHalo,
          'text-halo-width': 1.5,
        },
      },

      {
        id: 'route-halo', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.routeHalo, 'line-width': 9, 'line-opacity': 0.9 },
      },
      {
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': C.route, 'line-width': 4 },
      },

      {
        id: 'poi-dot', type: 'circle', source: 'pois',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2.5, 16, 4.5, 19, 7],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': C.dotStroke,
          'circle-stroke-width': 1.4,
          'circle-opacity': 1,
        },
      },
      {
        id: 'poi-label', type: 'symbol', source: 'pois',
        minzoom: 14.5,
        filter: ['==', ['get', 'pin'], true],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': [FONT],
          'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10, 19, 13.5],
          'text-offset': [0, 1.05],
          'text-anchor': 'top',
          'text-max-width': 8,
          'text-optional': true,
          'text-padding': 4,
          'symbol-sort-key': ['case', ['==', ['get', 'cat'], 'lecture'], 0,
                                      ['==', ['get', 'cat'], 'canteen'], 1, 2],
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.4,
        },
      },
      {
        id: 'poi-label-minor', type: 'symbol', source: 'pois',
        minzoom: 16.5,
        filter: ['all', ['!=', ['get', 'pin'], true], ['==', ['get', 'named'], true]],
        layout: {
          'text-field': ['get', 'name'],
          'text-font': [FONT],
          'text-size': ['interpolate', ['linear'], ['zoom'], 16.5, 9.5, 19.5, 12],
          'text-offset': [0, 1],
          'text-anchor': 'top',
          'text-max-width': 8,
          'text-optional': true,
          'text-padding': 3,
          'symbol-sort-key': 3,
        },
        paint: {
          'text-color': C.label,
          'text-halo-color': C.labelHalo,
          'text-halo-width': 1.3,
        },
      },
      {
        id: 'poi-focus', type: 'circle', source: 'pois',
        filter: ['==', ['get', 'focus'], true],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 9, 19, 18],
          'circle-color': 'transparent',
          'circle-stroke-color': C.focus,
          'circle-stroke-width': 1.6,
        },
      },
    ],
  }
}

/**
 * The area outside the campus wall as a single polygon with every boundary
 * ring (each parcel, and any hole inside a parcel) cut out as a hole. The
 * outer box is huge so the veil covers the whole viewport at every zoom and
 * pan. Rings are wound to the GeoJSON right-hand rule — exterior ring
 * counterclockwise, holes clockwise — though MapLibre re-winds on load
 * either way.
 */
function outsideFC(boundary: GeoJSON.FeatureCollection): GeoJSON.FeatureCollection {
  const signedArea = (ring: number[][]) => {
    let s = 0
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!, b = ring[i + 1]!
      s += a[0]! * b[1]! - b[0]! * a[1]!
    }
    return s / 2
  }
  // Holes run clockwise (negative area); reverse the ring if it is not.
  const asHole = (ring: number[][]) => (signedArea(ring) < 0 ? ring : [...ring].reverse())

  const holes: number[][][] = []
  for (const f of boundary.features ?? []) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'Polygon') g.coordinates.forEach((r) => holes.push(asHole(r)))
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((p) => p.forEach((r) => holes.push(asHole(r))))
  }

  // A boundary with no parcel (a broken/empty extract) must not dim the
  // entire world — with no hole the veil would cover everything.
  if (holes.length === 0) return { type: 'FeatureCollection', features: [] }

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[-180, -89], [180, -89], [180, 89], [-180, 89], [-180, -89]],
          ...holes,
        ],
      },
    }],
  }
}

/** `match` expression mapping a category key to its colour. */
function catColour(campus: Campus): maplibregl.ExpressionSpecification {
  const pairs: (string | string[])[] = []
  for (const [k, v] of Object.entries(campus.categories)) pairs.push(k, v.color)
  return ['match', ['get', 'cat'], ...pairs, '#8b949e'] as unknown as maplibregl.ExpressionSpecification
}

/**
 * Colours for the maplibre-gl-draw editing layers (gl-draw-*). The plugin
 * ships cyan/amber defaults that fight the brand, so the app overrides the
 * paint of every gl-draw-* layer after attaching the control: inactive shapes
 * in the boundary grey, active and in-progress shapes in the accent, and
 * vertex halos in the base.
 */
export function drawTints(theme: 'light' | 'dark'): {
  inactive: string
  active: string
  static: string
  halo: string
} {
  const C = PALETTE[theme]
  return { inactive: C.boundary, active: C.route, static: C.label, halo: C.dotStroke }
}
