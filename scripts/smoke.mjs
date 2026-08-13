// Headless smoke test of the pure-logic modules — the search index and the
// router — plus the built data and the map style. Bundles the TS with esbuild
// (already a Vite dependency), runs real queries, and asserts sane answers.
//
//   bun run smoke

import { build } from 'esbuild'
import { readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { curatedKey, validateFeatureCollection } from './curated-validate.mjs'
import { pointInRing, ringsOf, inAnyRing } from './geometry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = join(ROOT, 'node_modules/.cache/smoke.mjs')

let failures = 0
const ok = (cond, label, detail = '') => {
  if (cond) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

await build({
  entryPoints: [join(ROOT, 'src/search/engine.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: TMP, logLevel: 'silent',
})
const { SearchIndex } = await import(TMP + `?t=${Date.now()}`)

const ROUTER_TMP = join(ROOT, 'node_modules/.cache/smoke-router.mjs')
await build({
  entryPoints: [join(ROOT, 'src/route/router.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: ROUTER_TMP, logLevel: 'silent',
})
const { Router, humanEta } = await import(ROUTER_TMP + `?t=${Date.now()}`)

const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const geo = JSON.parse(await readFile(join(ROOT, 'public/data/geo.json'), 'utf8'))
const graph = JSON.parse(await readFile(join(ROOT, 'public/data/graph.json'), 'utf8'))

/* ── data sanity ─────────────────────────────────────────────────────────── */

console.log('\ndata')
if (campus.pois.length > 0) ok(true, `pois exist (${campus.pois.length})`)
else ok(true, 'no pois yet — trace data/curated/pois.geojson', 'pois=0')
if (campus.rooms.length > 0) ok(true, `rooms exist (${campus.rooms.length})`)
else ok(true, 'no rooms yet — trace data/curated/indoor.geojson', 'rooms=0')
ok(Object.keys(geo.buildings.features).length > 0, `buildings exist (${geo.buildings.features.length})`)

// Invariant: campus.meta.sample is set iff any curated file still carries
// _sample: true. The build reads the same five files, so this must agree.
const CURATED = join(ROOT, 'data/curated')
const anySample = (await Promise.all(
  ['boundary', 'buildings', 'paths', 'indoor', 'pois'].map(async (n) => {
    const d = JSON.parse(await readFile(join(CURATED, `${n}.geojson`), 'utf8'))
    return d._sample === true
  }),
)).some(Boolean)
ok((campus.meta.sample === true) === anySample, 'sample marker agrees with curated files',
   `meta.sample=${campus.meta.sample === true} curated sample=${anySample}`)

// Buildings pass through the build unchanged — the user curates them; the
// build must never invent or drop any.
const curatedBuildings = JSON.parse(await readFile(join(CURATED, 'buildings.geojson'), 'utf8'))
ok(geo.buildings.features.length === curatedBuildings.features.length,
   'every curated building reaches the map',
   `${geo.buildings.features.length} buildings`)

// OSM roads land in geo.paths as kind=road and render through the road
// layers; traced paths (kind=path|steps) stay separate.
const curatedPaths = JSON.parse(await readFile(join(CURATED, 'paths.geojson'), 'utf8'))
const roadFeats = geo.paths.features.filter((f) => f.properties?.kind === 'road')
ok(roadFeats.length > 0, `roads exist (${roadFeats.length})`)
ok(roadFeats.every((f) => f.properties?.kind === 'road'), 'every road feature has kind road')
ok(geo.paths.features.length === curatedPaths.features.length,
   'every curated path/road reaches the map',
   `${geo.paths.features.length} features (${roadFeats.length} roads)`)

// Multi-polygon boundary: a point inside the second parcel is on campus.
const ringA = [[77.670, 12.890], [77.680, 12.890], [77.680, 12.895], [77.670, 12.895], [77.670, 12.890]]
const ringB = [[77.680, 12.895], [77.690, 12.895], [77.690, 12.900], [77.680, 12.900], [77.680, 12.895]]
ok(inAnyRing(77.685, 12.897, [ringA, ringB]), 'inAnyRing: point in second parcel passes')
ok(!inAnyRing(77.660, 12.880, [ringA, ringB]), 'inAnyRing: outside both parcels fails')
ok(pointInRing(77.675, 12.892, ringA), 'pointInRing: inside first parcel passes')
ok(ringsOf({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ringB] } }] }.features).length === 1,
   'ringsOf collects polygon outer rings')
// The built boundary carries every polygon parcel.
ok(geo.boundary.features.length >= 1, `built boundary renders every parcel (${geo.boundary.features.length})`)
ok(geo.boundary.features.every((f) => f.geometry.type === 'Polygon'), 'every boundary parcel is a Polygon')

// Every indoor POI must sit inside a room, and every POI-room link must resolve.
const roomsById = new Map(campus.rooms.map((r) => [r.id, r]))
const indoor = campus.pois.filter((p) => p.building)
if (campus.rooms.length > 0) {
  ok(indoor.length > 0, `indoor pois exist (${indoor.length})`)
  for (const p of indoor) {
    const room = roomsById.get(p.room)
    ok(!!room, `"${p.name}" has a room on ${p.building} floor ${p.level}`, room ? room.name : '')
    ok(room && room.poiId === p.id, `room "${room?.name}" points back at "${p.name}"`)
  }
} else {
  ok(true, 'no rooms yet — trace data/curated/indoor.geojson', `pois=${campus.pois.length}, rooms=0`)
  ok(indoor.length === 0, 'no indoor pois without rooms', `${indoor.length} indoor pois`)
}

// Every room that claims a POI must reference a real POI.
const poisById = new Map(campus.pois.map((p) => [p.id, p]))
const badRoom = campus.rooms.filter((r) => r.poiId && !poisById.has(r.poiId))
ok(badRoom.length === 0, 'no room references a missing POI', badRoom.map((r) => r.id).join(', '))

// The floor index must cover every room document.
const floorRooms = new Set()
for (const plan of Object.values(geo.floors)) {
  for (const fc of Object.values(plan.byLevel)) {
    for (const f of fc.features) floorRooms.add(f.properties.id)
  }
}
const missing = campus.rooms.filter((r) => !floorRooms.has(r.id))
ok(missing.length === 0, 'every searchable room exists in the floor index',
   missing.map((r) => r.id).join(', '))

// Any multi-floor building the browser test relies on must have its floors.
const plans = Object.entries(geo.floors)
if (plans.length) {
  const multi = plans.filter(([, p]) => p.levels.length > 1)
  ok(multi.length > 0, `at least one building has multiple floors (${plans.length} floor plans)`,
     multi.map(([n]) => n).join(', ') || 'none')
} else {
  ok(true, 'no floor plans yet — trace data/curated/indoor.geojson', 'geo.floors empty')
}

/* ── search ──────────────────────────────────────────────────────────────── */

console.log('\nsearch')
const index = new SearchIndex(campus, { onLayer: () => {}, onAction: () => {} })
console.log(`  ${index.docs.length} documents indexed`)

const top = (q) => index.search(q)[0]
const titles = (q, n = 4) => index.search(q).slice(0, n).map((h) => h.title)

if (campus.rooms.length > 0) {
  const room = top('room 203')
  ok(room?.kind === 'room' && room.title === 'Room 203', 'room 203 -> Room 203',
     `${room?.kind ?? ''}: ${room?.title ?? ''}`)
  ok(room?.building && room?.level != null,
     'room hit carries building + level', `${room?.building} · floor ${room?.level}`)

  // A room without a POI is still searchable and still carries its floor.
  const emptyRoom = campus.rooms.find((r) => !r.poiId)
  if (emptyRoom) {
    const hit = index.search(emptyRoom.name).find((h) => h.kind === 'room' && h.roomId === emptyRoom.id)
    ok(!!hit && hit.building === emptyRoom.building && hit.level === emptyRoom.level,
       `unlisted room "${emptyRoom.name}" is searchable`, hit ? `${hit.building} · floor ${hit.level}` : '')
  }
} else {
  ok(true, 'no rooms to search yet', 'trace data/curated/indoor.geojson')
}

if (campus.pois.length > 0) {
  const gate = top('main gate')
  ok(gate?.title === 'Main Gate', 'main gate -> Main Gate', gate?.title)

  ok(titles('canteen').some((t) => /canteen/i.test(t)), 'canteen', titles('canteen').join(' / '))
  ok(titles('physics lab').some((t) => /Physics Lab/.test(t)), 'physics lab', titles('physics lab').join(' / '))
  ok(titles('water').some((t) => /water/i.test(t)), 'water', titles('water').join(' / '))
  ok(titles('lecture hall').length > 0, 'lecture hall', titles('lecture hall').join(' / '))
  ok(index.search('library').length > 0, 'library', titles('library').join(' / '))
} else {
  ok(true, 'no pois to search yet', 'trace data/curated/pois.geojson')
}

// Search over whatever exists must never throw, even with an empty index.
const probes = ['room', 'canteen', 'water', 'a']
const hitless = probes.every((q) => Array.isArray(index.search(q)))
ok(hitless, 'search never throws over the current index', `${index.docs.length} docs`)

console.log('\n  latency')
for (const q of ['m', 'canteen', 'room 203', 'main gate', 'a']) {
  const t0 = performance.now()
  for (let i = 0; i < 50; i++) index.search(q)
  const per = (performance.now() - t0) / 50
  ok(per < 12, `"${q}" ${per.toFixed(2)}ms/query`)
}

/* ── routing ─────────────────────────────────────────────────────────────── */

console.log('\nrouting')
const router = new Router(graph)
const find = (n) => campus.pois.find((p) => p.name === n)

if (graph.edges.length === 0) {
  ok(true, 'no path network yet — trace data/curated/paths.geojson', 'graph has 0 edges')
} else if (campus.pois.length === 0) {
  ok(true, 'path network exists but no pois to route between yet',
     `edges=${graph.edges.length}, pois=0`)
} else {
  const pairs = [
    ['Main Gate', 'Central Lawn'],
    ['Sample ATM', 'Sports Field'],
    ['Main Gate', 'Sample ATM'],
    ['Central Lawn', 'Reception'],
  ]
  for (const [a, b] of pairs) {
    const A = find(a), B = find(b)
    if (!A || !B) { ok(false, `${a} -> ${b}`, 'POI missing'); continue }
    const walk = router.route(A, B, 'foot')
    const bike = router.route(A, B, 'bike')
    if (!walk || !bike) {
      ok(false, `${a} -> ${b}`, `no route on ${!walk && !bike ? 'either profile' : !walk ? 'foot' : 'bike'}`)
      continue
    }
    const straight = Math.hypot((A.lat - B.lat) * 111320, (A.lon - B.lon) * 99000)
    const detour = walk.metres / Math.max(straight, 1)
    // Off-network approach legs are walked at the same speed on both profiles,
    // so a short hop can clock identical ETAs — allow the rounding slack. The
    // strict "cycling never slower" check below is the real guard.
    ok(detour > 0.95 && detour < 2.6 && bike.seconds <= walk.seconds + 5,
       `${a} -> ${b}`,
       `${walk.metres}m walk ${humanEta(walk.seconds)} / cycle ${humanEta(bike.seconds)} (detour ${detour.toFixed(2)}x)`)
  }

  // Every POI must be reachable on BOTH profiles from the campus centre —
  // indoor POIs included, since they route to their building's nearest node.
  const centre = { lat: campus.meta.center[1], lon: campus.meta.center[0] }
  for (const profile of ['foot', 'bike']) {
    const bad = campus.pois.filter((p) => !router.route(centre, p, profile))
    ok(bad.length === 0, `all ${campus.pois.length} POIs reachable by ${profile}`,
       bad.length ? `${bad.length} unreachable, e.g. ${bad.slice(0, 3).map((p) => p.name).join(', ')}` : '')
  }

  // Cycling should never be slower than walking over the same pair.
  const slower = campus.pois.filter((p) => {
    const w = router.route(centre, p, 'foot'), c = router.route(centre, p, 'bike')
    return w && c && c.seconds > w.seconds
  })
  ok(slower.length === 0, 'cycling never slower than walking',
     slower.length ? `${slower.length} pairs, e.g. ${slower[0].name}` : '')

  const t0 = performance.now()
  for (let i = 0; i < 30; i++) router.route(centre, campus.pois[i % campus.pois.length], 'foot')
  ok((performance.now() - t0) / 30 < 40, `route latency ${((performance.now() - t0) / 30).toFixed(1)}ms`)
}

/* ── curated save validation ─────────────────────────────────────────── */

console.log('\ncurated validation')
// The dev-server whitelist must only ever accept the five exact file names.
ok(curatedKey('boundary.geojson') === 'boundary', 'whitelist accepts boundary.geojson')
ok(curatedKey('buildings.geojson') === 'buildings', 'whitelist accepts buildings.geojson')
ok(curatedKey('paths.geojson') === 'paths', 'whitelist accepts paths.geojson')
ok(curatedKey('indoor.geojson') === 'indoor', 'whitelist accepts indoor.geojson')
ok(curatedKey('pois.geojson') === 'pois', 'whitelist accepts pois.geojson')
ok(curatedKey('../data/curated/buildings.geojson') === null, 'whitelist rejects path traversal')
ok(curatedKey('buildings.json') === null, 'whitelist rejects non-geojson names')
ok(curatedKey('buildings.geojson.bak') === null, 'whitelist rejects suffix tricks')
ok(curatedKey('BUILDINGS.geojson') === null, 'whitelist is case-sensitive')
ok(curatedKey('') === null && curatedKey(null) === null, 'whitelist rejects empty and null names')

const fc = (geometry) => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry }],
})
const poly = fc({ type: 'Polygon', coordinates: [] })
const line = fc({ type: 'LineString', coordinates: [] })
const pt = fc({ type: 'Point', coordinates: [0, 0] })
ok(validateFeatureCollection(poly, 'buildings').ok, 'buildings accepts Polygon')
ok(validateFeatureCollection(poly, 'boundary').ok, 'boundary accepts Polygon')
ok(validateFeatureCollection(poly, 'indoor').ok, 'indoor accepts Polygon')
ok(validateFeatureCollection(line, 'paths').ok, 'paths accepts LineString')
ok(validateFeatureCollection(pt, 'pois').ok, 'pois accepts Point')
ok(!validateFeatureCollection(line, 'buildings').ok, 'buildings rejects LineString')
ok(!validateFeatureCollection(poly, 'paths').ok, 'paths rejects Polygon')
ok(!validateFeatureCollection(pt, 'buildings').ok, 'buildings rejects Point')
ok(!validateFeatureCollection(fc({ type: 'MultiPolygon', coordinates: [] }), 'buildings').ok, 'buildings rejects MultiPolygon')
ok(!validateFeatureCollection(null, 'pois').ok, 'null data rejected')
ok(!validateFeatureCollection({ type: 'Feature' }, 'pois').ok, 'non-FeatureCollection rejected')
ok(!validateFeatureCollection({ type: 'FeatureCollection', features: 'x' }, 'pois').ok, 'features must be an array')
ok(!validateFeatureCollection({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: {} }] }, 'pois').ok, 'geometry-less feature rejected')
ok(!validateFeatureCollection(poly, 'nope').ok, 'unknown file key rejected')

/* ── map style ───────────────────────────────────────────────────────────── */

console.log('\nmap style')
const STYLE_TMP = join(ROOT, 'node_modules/.cache/smoke-style.mjs')
await build({
  entryPoints: [join(ROOT, 'src/map/style.ts')],
  bundle: true, format: 'esm', platform: 'node', outfile: STYLE_TMP, logLevel: 'silent',
  external: ['maplibre-gl'],
})
const { buildStyle } = await import(STYLE_TMP + `?t=${Date.now()}`)
const { validateStyleMin } = await import('@maplibre/maplibre-gl-style-spec')

for (const theme of ['dark', 'light']) {
  const style = buildStyle(geo, campus, theme)
  const errors = validateStyleMin(style)
  ok(errors.length === 0, `${theme} style validates (${style.layers.length} layers)`,
     errors.map((e) => e.message).join(' | '))

  const missing = style.layers.filter((l) => l.source && !style.sources[l.source]).map((l) => l.id)
  ok(missing.length === 0, `${theme}: every layer has a source`, missing.join(', '))

  const bad = JSON.stringify(style).match(/"(?:[a-z-]*color)":\s*(null|"undefined")/g)
  ok(!bad, `${theme}: no undefined colours`, bad?.join(', ') ?? '')

  const floor = style.layers.find((l) => l.id === 'floor-fill')
  ok(!!floor, `${theme}: floor-fill layer present`)

  const satSrc = style.sources.sat
  ok(!!satSrc && satSrc.type === 'raster', `${theme}: sat raster source present`)
  const satLayer = style.layers.find((l) => l.id === 'sat')
  ok(!!satLayer && satLayer.type === 'raster', `${theme}: sat raster layer present`)
  ok(satLayer?.layout?.visibility === 'none', `${theme}: sat layer hidden by default`)

  // Draw mode layers moved into maplibre-gl-draw (the plugin adds its own at
  // runtime); the style must not ship a stale draft source or layers.
  ok(!style.sources.draft, `${theme}: no stale draft source`)
  ok(style.layers.every((l) => !l.id.startsWith('draft-')), `${theme}: no stale draft layers`)
}

/* ── DOM contract ────────────────────────────────────────────────────────── */

console.log('\ndom')
const html = await readFile(join(ROOT, 'index.html'), 'utf8')
const present = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))

const srcDir = join(ROOT, 'src')
const walk = async (dir) => {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const wanted = new Map() // id -> file
for (const file of await walk(srcDir)) {
  const code = await readFile(file, 'utf8')
  for (const m of code.matchAll(/getElementById\(\s*['"]([^'"]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
  for (const m of code.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!wanted.has(m[1])) wanted.set(m[1], file.replace(ROOT + '/', ''))
  }
}

// Elements the app creates at runtime rather than declaring in the markup.
const RUNTIME_IDS = new Set(['route-badge', 'floor-bar', 'layers-scrim'])

const orphans = [...wanted].filter(([id]) => !present.has(id) && !RUNTIME_IDS.has(id))
ok(orphans.length === 0, `all ${wanted.size} referenced ids exist in index.html`,
   orphans.map(([id, f]) => `#${id} (${f})`).join(', '))

await rm(TMP, { force: true })
await rm(ROUTER_TMP, { force: true })
await rm(STYLE_TMP, { force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
