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
 */
const PALETTE = {
  dark: {
    bg: '#0b0d10',
    campus: '#10141a',
    building: '#181d25',
    buildingEdge: '#232a35',
    named: '#1d2430',
    road: '#2a313d',
    roadCase: '#171b22',
    path: '#2e3743',
    steps: '#3a4250',
    boundary: '#28303c',
    label: '#9aa4b2',
    labelHalo: '#0b0d10',
    dotStroke: '#0b0d10',
    routeHalo: '#0b0d10',
    route: '#58a6ff',
    focus: '#61d47c',
    dim: '#05070a',
    floorBase: '#202832',
    floorEdge: '#2e3a47',
    floorLabel: '#aeb8c4',
    floorLabelHalo: '#0b0d10',
    activeOutline: '#61d47c',
  },
  light: {
    bg: '#d7dade',
    campus: '#eeece7',
    building: '#dedbd3',
    buildingEdge: '#c4bfb3',
    named: '#d5d0c5',
    road: '#ffffff',
    roadCase: '#c8c3b7',
    path: '#ffffff',
    steps: '#a9a294',
    boundary: '#a8a294',
    label: '#2f343b',
    labelHalo: '#ffffff',
    dotStroke: '#ffffff',
    routeHalo: '#ffffff',
    route: '#1a5fb4',
    focus: '#1d7a41',
    dim: '#f4f3ef',
    floorBase: '#d2cdc0',
    floorEdge: '#b7b0a0',
    floorLabel: '#333a44',
    floorLabelHalo: '#eeece7',
    activeOutline: '#1d7a41',
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
        },
      },
      {
        id: 'road', type: 'line', source: 'paths',
        filter: ['==', ['get', 'kind'], 'road'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.road,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 13, 1, 16, 4.5, 19, 16],
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
        },
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

/** `match` expression mapping a category key to its colour. */
function catColour(campus: Campus): maplibregl.ExpressionSpecification {
  const pairs: (string | string[])[] = []
  for (const [k, v] of Object.entries(campus.categories)) pairs.push(k, v.color)
  return ['match', ['get', 'cat'], ...pairs, '#8b949e'] as unknown as maplibregl.ExpressionSpecification
}
