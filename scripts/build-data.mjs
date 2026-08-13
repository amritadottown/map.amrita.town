// Turns data/curated/*.geojson (hand-traced, community-curated) into the three
// files the app loads: public/data/{campus,geo,graph}.json
//
//   node scripts/build-data.mjs
//
// boundary.geojson and buildings.geojson ship a real OpenStreetMap base
// (ODbL) — the campus wall and building footprints, clipped to it. The rest is
// curated by hand: files traced at geojson.io are dropped into data/curated/
// and rebuilt here. While any file carries the top-level "_sample": true marker
// the build prints a loud warning, so placeholder data can never silently
// reach a live deploy.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pointInRing, ringsOf, inAnyRing } from './geometry.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURATED = join(ROOT, 'data/curated')
const OUT = join(ROOT, 'public/data')

const warnings = []
const warn = (m) => warnings.push(m)

/* ── categories ─────────────────────────────────────────────────────────── */
// Every POI lands in exactly one category. `pin` = drawn as a labelled marker;
// others are drawn only when their layer is on.

export const CATEGORIES = {
  lecture:  { label: 'Lecture halls',   color: '#ffb454', pin: true },
  academic: { label: 'Academic blocks', color: '#8ab4f8', pin: true },
  admin:    { label: 'Admin & help',    color: '#9ea7b3', pin: false },
  hostel:   { label: 'Hostels',         color: '#c792ea', pin: true },
  mess:     { label: 'Messes',          color: '#7ee787', pin: true },
  canteen:  { label: 'Canteens & cafés', color: '#7ee787', pin: true },
  shop:     { label: 'Shops',           color: '#a5d6ff', pin: false },
  library:  { label: 'Library',         color: '#d2a8ff', pin: true },
  health:   { label: 'Health',          color: '#ff7b72', pin: false },
  sports:   { label: 'Sports',          color: '#3fb950', pin: false },
  transport:{ label: 'Transport',       color: '#ff9bce', pin: false },
  water:    { label: 'Water',           color: '#56d4dd', pin: false },
  atm:      { label: 'ATMs & banks',    color: '#ffdd57', pin: false },
  worship:  { label: 'Worship',         color: '#bc8cff', pin: false },
  toilet:   { label: 'Toilets',         color: '#8b949e', pin: false },
  parking:  { label: 'Parking',         color: '#79c0ff', pin: false },
  green:    { label: 'Open ground',     color: '#2ea043', pin: false },
}

/* ── geo helpers ────────────────────────────────────────────────────────── */

const R = 6371008.8
const rad = (d) => (d * Math.PI) / 180

function haversine(aLat, aLon, bLat, bLon) {
  const dLat = rad(bLat - aLat)
  const dLon = rad(bLon - aLon)
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function centroid(geometry) {
  const g = geometry.filter(Boolean)
  if (g.length < 3) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < g.length - 1; i++) {
    const p = g[i], q = g[i + 1]
    const f = p.lon * q.lat - q.lon * p.lat
    a += f
    cx += (p.lon + q.lon) * f
    cy += (p.lat + q.lat) * f
  }
  if (Math.abs(a) < 1e-12) {
    const lat = g.reduce((s, p) => s + p.lat, 0) / g.length
    const lon = g.reduce((s, p) => s + p.lon, 0) / g.length
    return [lon, lat]
  }
  a *= 0.5
  return [cx / (6 * a), cy / (6 * a)]
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'
}

const readCurated = async (n) => JSON.parse(await readFile(join(CURATED, `${n}.geojson`), 'utf8'))

/* ── main ───────────────────────────────────────────────────────────────── */

async function main() {
  for (const f of ['boundary', 'buildings', 'paths', 'indoor', 'pois']) {
    if (!existsSync(join(CURATED, `${f}.geojson`))) {
      console.error(`missing data/curated/${f}.geojson — trace it at geojson.io first`)
      process.exit(1)
    }
  }

  const [boundary, buildings, paths, indoor, pois] = await Promise.all(
    ['boundary', 'buildings', 'paths', 'indoor', 'pois'].map(readCurated),
  )

  const sampleFiles = [
    ['boundary', boundary], ['buildings', buildings], ['paths', paths],
    ['indoor', indoor], ['pois', pois],
  ].filter(([, d]) => d._sample === true).map(([n]) => n)
  if (sampleFiles.length) {
    warn(`SAMPLE DATA IN USE — still carries "_sample": true: ${sampleFiles.join(', ')}. ` +
         'Replace those data/curated files with traced data before publishing.')
  }

  /* boundary rings — every polygon feature is a parcel of the campus; a
     point is on campus when it falls inside at least one of them (the main
     site plus, say, a hostel block across the road). */
  const rings = ringsOf(boundary.features)
  if (!rings.length) throw new Error('boundary.geojson has no polygon feature')
  const inCampus = (lon, lat) => inAnyRing(lon, lat, rings)

  const fc = (features) => ({ type: 'FeatureCollection', features })
  const polyOf = (coords, props) => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [coords] },
  })

  /* ── buildings ────────────────────────────────────────────────────────── */
  const buildingByName = new Map()
  const buildingF = []
  for (const f of buildings.features ?? []) {
    if (!f.geometry || f.geometry.type !== 'Polygon') { warn('buildings: non-polygon feature skipped'); continue }
    const p = f.properties ?? {}
    const name = p.name || ''
    const cat = p.cat || ''
    if (cat && !CATEGORIES[cat]) { warn(`building "${name || 'unnamed'}": unknown cat "${cat}"`); continue }
    const c = f.geometry.coordinates[0]
    const [lon, lat] = centroid(c.map(([x, y]) => ({ lon: x, lat: y })))
    if (!inCampus(lon, lat)) { warn(`building "${name || 'unnamed'}" is outside the campus boundary — skipped`); continue }
    const levels = Math.max(1, Math.round(+p.levels) || 1)
    const id = p.id || slugify(name) || `building-${buildingF.length}`
    const props = { id, name, cat, levels }
    if (name) buildingByName.set(name, { id, levels })
    buildingF.push(polyOf(c, props))
  }

  /* ── indoor floors ────────────────────────────────────────────────────── */
  const roomsByKey = new Map() // `${building}|${level}` -> [room features]
  for (const f of indoor.features ?? []) {
    if (!f.geometry || f.geometry.type !== 'Polygon') { warn('indoor: non-polygon feature skipped'); continue }
    const p = f.properties ?? {}
    if (!p.building || p.level == null || !p.room) {
      warn(`indoor: feature missing building/level/room — skipped`); continue
    }
    if (!buildingByName.has(p.building)) {
      warn(`indoor: room "${p.room}" references unknown building "${p.building}" — skipped`); continue
    }
    const level = Math.round(+p.level)
    const c = f.geometry.coordinates[0]
    const id = p.id || slugify(`${p.building} ${p.level} ${p.room}`)
    const key = `${p.building}|${level}`
    if (!roomsByKey.has(key)) roomsByKey.set(key, [])
    roomsByKey.get(key).push(polyOf(c, {
      id,
      name: p.room,
      kind: p.kind || 'room',
      building: p.building,
      level,
    }))
  }

  // Bbox sanity: overlapping rooms on the same floor are almost certainly a
  // tracing mistake. Report the overlap, do not silently pick one.
  for (const [key, rooms] of roomsByKey) {
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = bbox(rooms[i].geometry.coordinates[0]), b = bbox(rooms[j].geometry.coordinates[0])
        if (a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]) {
          warn(`indoor: "${rooms[i].properties.name}" overlaps "${rooms[j].properties.name}" on ${key}`)
        }
      }
    }
  }

  const floors = {}
  for (const [key, rooms] of roomsByKey) {
    const [building, level] = key.split('|')
    const plan = floors[building] ?? (floors[building] = { levels: [], byLevel: {} })
    plan.byLevel[level] = fc(rooms)
    if (!plan.levels.includes(+level)) plan.levels.push(+level)
  }
  for (const plan of Object.values(floors)) plan.levels.sort((a, b) => a - b)

  /* ── POIs ─────────────────────────────────────────────────────────────── */
  const poisOut = []
  const usedIds = new Set()
  const roomIndex = new Map() // building|level -> [ {id, name, coords} ]
  for (const [key, rooms] of roomsByKey) {
    roomIndex.set(key, rooms.map((r) => ({
      id: r.properties.id,
      name: r.properties.name,
      coords: r.geometry.coordinates[0],
    })))
  }

  for (const f of pois.features ?? []) {
    if (!f.geometry || f.geometry.type !== 'Point') { warn('pois: non-point feature skipped'); continue }
    const p = f.properties ?? {}
    if (!p.name) { warn('pois: feature without a name skipped'); continue }
    const cat = p.cat
    if (!CATEGORIES[cat]) { warn(`poi "${p.name}": unknown cat "${cat}"`); continue }
    const [lon, lat] = f.geometry.coordinates

    let id = p.id || slugify(p.name)
    while (usedIds.has(id)) id = `${id}-${usedIds.size}`
    usedIds.add(id)

    const out = {
      id,
      name: p.name,
      cat,
      lat: +lat.toFixed(6),
      lon: +lon.toFixed(6),
      src: 'seed',
      ...(p.aliases?.length ? { aliases: p.aliases } : {}),
      ...(p.hours ? { hours: p.hours } : {}),
      ...(p.wheelchair ? { wheelchair: p.wheelchair } : {}),
      ...(p.phone ? { phone: p.phone } : {}),
      ...(p.url ? { url: p.url } : {}),
      ...(p.desc ? { desc: p.desc } : {}),
      ...(p.kind ? { kind: p.kind } : {}),
    }

    if (p.building != null) {
      // Indoor POI — must sit inside a room on that building+level, and the
      // room is what gets highlighted on the map (no dot pins indoors).
      if (!buildingByName.has(p.building)) {
        warn(`poi "${p.name}" references unknown building "${p.building}" — skipped`)
        continue
      }
      const level = Math.round(+p.level)
      const rooms = roomIndex.get(`${p.building}|${level}`) ?? []
      const hit = rooms.find((r) => pointInRing(lon, lat, r.coords))
      if (!hit) {
        warn(`poi "${p.name}" is not inside any room of ${p.building} floor ${level} — skipped`)
        continue
      }
      out.building = p.building
      out.level = level
      out.room = hit.id
      // Mark the room so the floor view renders it brighter.
      const key = `${p.building}|${level}`
      for (const room of roomsByKey.get(key)) {
        if (room.properties.id === hit.id) {
          room.properties.poi = 1
          room.properties.poiCat = cat
          room.properties.poiName = p.name
          room.properties.poiId = id
        }
      }
    } else {
      if (!inCampus(lon, lat)) { warn(`poi "${p.name}" is outside the campus boundary — skipped`); continue }
    }
    poisOut.push(out)
  }

  // The rooms list feeds search ("room 203 opens its building and floor").
  const roomDocs = []
  for (const [key, rooms] of roomsByKey) {
    const [building, level] = key.split('|')
    for (const r of rooms) {
      roomDocs.push({
        id: r.properties.id,
        name: r.properties.name,
        building,
        level: +level,
        ...(r.properties.poiId ? { poiId: r.properties.poiId } : {}),
      })
    }
  }
  roomDocs.sort((a, b) => a.name.localeCompare(b.name))

  const poiList = poisOut.sort((a, b) => a.name.localeCompare(b.name))

  /* ── GeoJSON layers ───────────────────────────────────────────────────── */
  const pathF = []
  for (const f of paths.features ?? []) {
    if (!f.geometry || f.geometry.type !== 'LineString') { warn('paths: non-line feature skipped'); continue }
    if (f.geometry.coordinates.length < 2) continue
    const p = f.properties ?? {}
    pathF.push({
      type: 'Feature',
      properties: { kind: p.kind || 'path', surface: p.surface || '' },
      geometry: { type: 'LineString', coordinates: f.geometry.coordinates.map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)]) },
    })
  }

  const geo = {
    boundary: fc((boundary.features ?? [])
      .filter((f) => f.geometry?.type === 'Polygon')
      .map((f) => ({
        type: 'Feature',
        properties: { name: f.properties?.name || 'Amrita Bengaluru campus' },
        geometry: {
          type: 'Polygon',
          coordinates: [f.geometry.coordinates[0].map(([x, y]) => [+x.toFixed(6), +y.toFixed(6)])],
        },
      }))),
    buildings: fc(buildingF),
    paths: fc(pathF),
    floors,
  }

  /* ── routing graph ────────────────────────────────────────────────────── */
  // Topology comes from exact coordinate identity — shared endpoints must
  // serialise to identical lat/lon, which is what snapping in the tracer gives.
  const key = (lat, lon) => `${lat.toFixed(7)},${lon.toFixed(7)}`
  const nodeIndex = new Map()
  const nodeLat = [], nodeLon = []
  const getNode = (lat, lon) => {
    const k = key(lat, lon)
    let i = nodeIndex.get(k)
    if (i === undefined) {
      i = nodeLat.length
      nodeIndex.set(k, i)
      nodeLat.push(+lat.toFixed(6))
      nodeLon.push(+lon.toFixed(6))
    }
    return i
  }

  // Edge cost model. Cost is in seconds; ETA falls straight out of the search.
  const WALK = 1.35 // m/s — ~4.9 km/h, a normal campus walking pace
  const BIKE = 4.2  // m/s — ~15 km/h on open road

  function speeds(t) {
    const hw = t.kind
    if (hw === 'steps') return { foot: WALK * 0.45, bike: 0.6, dismount: true }
    if (hw === 'road') {
      if (t.surface === 'unpaved') return { foot: WALK * 0.85, bike: BIKE * 0.6 }
      return { foot: WALK * 0.95, bike: BIKE }
    }
    if (hw === 'path') {
      return { foot: WALK, bike: t.surface === 'unpaved' ? BIKE * 0.55 : BIKE * 0.72 }
    }
    return { foot: WALK, bike: BIKE * 0.8 }
  }

  const edges = [] // [a, b, metres, footSec, bikeSec, flags]
  const FLAG_STEPS = 1, FLAG_UNPAVED = 8

  for (const el of pathF) {
    const t = el.properties
    const coords = el.geometry.coordinates
    const sp = speeds(t)
    let flags = 0
    if (sp.dismount) flags |= FLAG_STEPS
    if (t.surface === 'unpaved') flags |= FLAG_UNPAVED

    for (let i = 0; i < coords.length - 1; i++) {
      const [plon, plat] = coords[i], [qlon, qlat] = coords[i + 1]
      const a = getNode(plat, plon), b = getNode(qlat, qlon)
      if (a === b) continue
      const m = haversine(plat, plon, qlat, qlon)
      if (m < 0.05) continue
      const round2 = (x) => Math.round(x * 100) / 100
      const footSec = sp.foot > 0 ? round2(m / sp.foot) : -1
      const bikeSec = sp.bike > 0 ? round2(m / sp.bike) : -1
      edges.push([a, b, Math.round(m * 10) / 10, footSec, bikeSec, flags])
    }
  }

  // Largest connected component only — stray disconnected stubs make routing
  // fail in ways that look like bugs to the user.
  const adj = Array.from({ length: nodeLat.length }, () => [])
  edges.forEach(([a, b], i) => { adj[a].push(i); adj[b].push(i) })
  const comp = new Int32Array(nodeLat.length).fill(-1)
  let best = -1, bestSize = 0
  for (let s = 0, c = 0; s < nodeLat.length; s++) {
    if (comp[s] !== -1) continue
    let size = 0
    const stack = [s]
    comp[s] = c
    while (stack.length) {
      const n = stack.pop(); size++
      for (const ei of adj[n]) {
        const e = edges[ei]
        const o = e[0] === n ? e[1] : e[0]
        if (comp[o] === -1) { comp[o] = c; stack.push(o) }
      }
    }
    if (size > bestSize) { bestSize = size; best = c }
    c++
  }

  const remap = new Int32Array(nodeLat.length).fill(-1)
  const gLat = [], gLon = []
  for (let i = 0; i < nodeLat.length; i++) {
    if (comp[i] !== best) continue
    remap[i] = gLat.length
    gLat.push(nodeLat[i]); gLon.push(nodeLon[i])
  }
  const gEdges = []
  for (const [a, b, m, f, k, fl] of edges) {
    if (comp[a] !== best) continue
    gEdges.push([remap[a], remap[b], m, f, k, fl])
  }

  const graph = {
    note: 'Costs are seconds; -1 = that profile cannot use the edge. flags: 1=steps 8=unpaved-shortcut',
    lat: gLat, lon: gLon, edges: gEdges,
    dropped: nodeLat.length - gLat.length,
  }

  /* ── output ───────────────────────────────────────────────────────────── */
  const counts = {}
  for (const p of poiList) counts[p.cat] = (counts[p.cat] || 0) + 1

  const campus = {
    meta: {
      name: 'Amrita Vishwa Vidyapeetam, Bengaluru',
      built: new Date().toISOString().slice(0, 10),
      center: [77.6745, 12.8946],
      attribution: '(c) OpenStreetMap contributors (ODbL) · community-curated additions',
      counts,
      ...(sampleFiles.length ? { sample: true } : {}),
    },
    categories: CATEGORIES,
    pois: poiList,
    rooms: roomDocs,
  }

  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, 'campus.json'), JSON.stringify(campus))
  await writeFile(join(OUT, 'geo.json'), JSON.stringify(geo))
  await writeFile(join(OUT, 'graph.json'), JSON.stringify(graph))

  const kb = (o) => (JSON.stringify(o).length / 1024).toFixed(0) + ' kB'
  console.log(`pois       ${poiList.length} (${poiList.filter((p) => !p.building).length} outdoor + ${poiList.filter((p) => p.building).length} indoor)`)
  console.log(`  ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  ')}`)
  console.log(`buildings  ${buildingF.length}`)
  console.log(`floors     ${Object.keys(floors).length} buildings, ${roomDocs.length} rooms`)
  console.log(`paths      ${pathF.length} (${gLat.length} graph nodes, ${gEdges.length} edges, ${graph.dropped} off-network dropped)`)
  console.log(`output     campus ${kb(campus)}, geo ${kb(geo)}, graph ${kb(graph)}`)
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`)
    for (const w of [...new Set(warnings)].slice(0, 25)) console.log(`  ! ${w}`)
  }
}

function bbox(ring) {
  let w = 180, s = 90, e = -180, n = -90
  for (const [x, y] of ring) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y) }
  return [w, s, e, n]
}

main().catch((e) => { console.error(e); process.exit(1) })
