import './styles.css'
import 'maplibre-gl-draw/dist/mapbox-gl-draw.css'
import maplibregl from 'maplibre-gl'
import MapboxDraw from 'maplibre-gl-draw'
import type { Campus, GeoData, Graph, Poi, Profile } from './types'
import { buildStyle } from './map/style'
import { Router, humanEta, humanDistance } from './route/router'
import { SearchIndex, type Hit } from './search/engine'
import { initPalette, openPalette } from './ui/palette'
import { initPanel, showAbout, showBuilding, showPoi, showRoom, hidePanel } from './ui/panel'
import { toggle as toggleTheme, onThemeChange, resolved } from './ui/theme'

const boot = document.getElementById('boot')!
const base = import.meta.env.BASE_URL

async function json<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function start() {
  const [campus, geo, graphData] = await Promise.all([
    json<Campus>('campus.json'),
    json<GeoData>('geo.json'),
    json<Graph>('graph.json'),
  ])

  const router = new Router(graphData)
  const byId = new Map(campus.pois.map((p) => [p.id, p]))
  const buildingIdByName = new Map(
    (geo.buildings.features ?? []).map((f) => [f.properties?.name as string, f.properties?.id as string]),
  )

  // The category palette is tuned for a dark ground and washes out on a pale
  // one. Darken in HSL, holding hue and saturation and moving only lightness.
  const shadeCache = new Map<string, string>()
  function catColour(cat: string): string {
    const base = campus.categories[cat]?.color ?? '#8b949e'
    if (resolved() === 'dark') return base
    const hit = shadeCache.get(base)
    if (hit) return hit

    const n = parseInt(base.slice(1), 16)
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, bl = (n & 255) / 255
    const max = Math.max(r, g, bl), min = Math.min(r, g, bl)
    const l = (max + min) / 2
    const d = max - min
    let h = 0
    const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    if (d !== 0) {
      h = max === r ? ((g - bl) / d) % 6 : max === g ? (bl - r) / d + 2 : (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    const L = Math.min(l, 0.38)
    const S = Math.min(1, sat * 1.05)
    const c = (1 - Math.abs(2 * L - 1)) * S
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = L - c / 2
    const seg: [number, number, number] =
      h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
      : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
    const out = '#' + seg
      .map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')
    shadeCache.set(base, out)
    return out
  }

  /* ── map ──────────────────────────────────────────────────────────────── */

  const map = new maplibregl.Map({
    container: 'map',
    style: buildStyle(geo, campus, resolved(), base),
    center: campus.meta.center,
    // Zoomed into the campus but not filling the viewport — the dimmed
    // surroundings stay visible around the wall. (MapLibre v4 uses 512px
    // tiles, so this renders roughly like z18 on a 256px-tile basemap.)
    zoom: 16.8,
    minZoom: 13,
    maxZoom: 19.5,
    maxBounds: [[77.66, 12.88], [77.69, 12.91]],
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  })
  map.touchZoomRotate.disableRotation()
  ;(window as unknown as { __map: maplibregl.Map }).__map = map
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
  }), 'bottom-right')

  /* ── layer state ──────────────────────────────────────────────────────── */

  const DEFAULT_OFF = new Set<string>([])
  const active = new Set(
    Object.keys(campus.categories).filter((c) => campus.meta.counts[c] && !DEFAULT_OFF.has(c)),
  )
  let focusId: string | null = null

  function poiFeatures(): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: campus.pois
        // Indoor places are their rooms, never dots.
        .filter((p) => !p.building)
        .filter((p) => active.has(p.cat) || p.id === focusId)
        .map((p) => ({
          type: 'Feature' as const,
          id: p.id,
          properties: {
            id: p.id,
            name: p.name,
            cat: p.cat,
            color: catColour(p.cat),
            pin: !!campus.categories[p.cat]?.pin,
            named: true,
            focus: p.id === focusId,
          },
          geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] },
        })),
    }
  }

  function refreshPois() {
    ;(map.getSource('pois') as maplibregl.GeoJSONSource | undefined)?.setData(poiFeatures())
    if (map.getLayer('building-cat')) {
      map.setFilter('building-cat', ['all',
        ['!=', ['get', 'cat'], ''],
        ['in', ['get', 'cat'], ['literal', [...active]]],
      ])
    }
    paintChips()
  }

  /* ── layer chips ──────────────────────────────────────────────────────── */

  const rail = document.getElementById('layers')!
  const cats = Object.entries(campus.categories)
    .filter(([c]) => campus.meta.counts[c])
    .sort((a, b) => (campus.meta.counts[b[0]] ?? 0) - (campus.meta.counts[a[0]] ?? 0))

  const chipBox = document.getElementById('layer-chips')!
  const layersBtn = document.getElementById('layers-btn')!

  function paintRail() {
    chipBox.innerHTML = cats.map(([c, meta]) =>
      `<button class="chip" data-cat="${c}" aria-pressed="false" style="color:${catColour(c)}"
         title="${meta.label} · ${campus.meta.counts[c]}">
         <span class="dot"></span>${meta.label}<span class="n">${campus.meta.counts[c]}</span>
       </button>`).join('')
    paintChips()
  }
  paintRail()

  function paintChips() {
    chipBox.querySelectorAll<HTMLElement>('.chip').forEach((c) =>
      c.setAttribute('aria-pressed', String(active.has(c.dataset.cat!))))
    layersBtn.querySelector('.n')!.textContent = `${active.size}`
    layersBtn.setAttribute('aria-label', `Layers — ${active.size} of ${cats.length} shown`)
  }

  rail.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.layers-close')) { closeLayers(); return }
    if (t.closest('[data-all]')) { cats.forEach(([c]) => active.add(c)); refreshPois(); return }
    if (t.closest('[data-none]')) { active.clear(); refreshPois(); return }
    const chip = t.closest('.chip') as HTMLElement | null
    if (!chip) return
    const c = chip.dataset.cat!
    active.has(c) ? active.delete(c) : active.add(c)
    refreshPois()
  })

  const scrim = document.createElement('div')
  scrim.id = 'layers-scrim'
  scrim.hidden = true
  document.body.append(scrim)

  function openLayers() {
    rail.classList.add('open')
    scrim.hidden = false
    layersBtn.setAttribute('aria-expanded', 'true')
  }
  function closeLayers() {
    rail.classList.remove('open')
    scrim.hidden = true
    layersBtn.setAttribute('aria-expanded', 'false')
  }
  layersBtn.addEventListener('click', () =>
    rail.classList.contains('open') ? closeLayers() : openLayers())
  scrim.addEventListener('click', closeLayers)

  /* ── multi-floor ──────────────────────────────────────────────────────── */

  const FLOOR_DIM: Record<'light' | 'dark', string> = { dark: '#202832', light: '#d2cdc0' }
  const FLOOR_FOCUS: Record<'light' | 'dark', string> = { dark: '#61d47c', light: '#1d7a41' }

  function mixHex(a: string, b: string, t: number): string {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16)
    const r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t)
    const g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t)
    const bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t)
    return '#' + [r, g, bl].map((v) => v.toString(16).padStart(2, '0')).join('')
  }

  /** The active floor's rooms, with a precomputed fill per room. POI rooms are
   *  tinted brighter, the focused room brightest, everything else dimmer. */
  function floorFC(building: string, level: number, focusRoom?: string): GeoJSON.FeatureCollection {
    const base = geo.floors[building]?.byLevel[String(level)]
    const theme = resolved()
    const dim = FLOOR_DIM[theme]
    const focus = FLOOR_FOCUS[theme]
    return {
      type: 'FeatureCollection',
      features: (base?.features ?? []).map((f) => {
        const p = f.properties ?? {}
        const poi = p.poi === 1
        const focused = focusRoom != null && p.id === focusRoom
        return {
          type: 'Feature' as const,
          properties: {
            id: p.id,
            name: p.name,
            kind: p.kind,
            label: p.kind === 'corridor' ? '' : p.name,
            poi: poi ? 1 : 0,
            focus: focused ? 1 : 0,
            // The click handler needs poiId to open the POI panel; without it
            // every highlighted room falls through to the empty-room hint.
            poiId: poi ? p.poiId : undefined,
            poiName: poi ? p.poiName : undefined,
            fill: focused ? focus : poi ? mixHex(catColour(p.poiCat as string), dim, 0.45) : dim,
          },
          geometry: f.geometry,
        }
      }),
    }
  }

  let activeFloor: { building: string; level: number } | null = null
  let focusRoom: string | null = null

  const floorBar = document.createElement('div')
  floorBar.id = 'floor-bar'
  floorBar.hidden = true
  floorBar.innerHTML = `
    <span class="fb-title"></span>
    <span class="fb-chips"></span>
    <button class="x" data-close aria-label="Close floor view">&times;</button>`
  document.body.append(floorBar)

  function paintFloorChips() {
    if (!activeFloor) return
    const plan = geo.floors[activeFloor.building]
    const title = floorBar.querySelector('.fb-title')!
    title.textContent = activeFloor.building
    const box = floorBar.querySelector('.fb-chips')!
    box.innerHTML = (plan?.levels ?? []).map((l) =>
      `<button type="button" data-level="${l}" class="${l === activeFloor!.level ? 'on' : ''}"
         aria-pressed="${l === activeFloor!.level}">${l === 0 ? 'G' : l}</button>`).join('')
  }

  floorBar.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.close !== undefined) { closeFloor(); return }
    if (t.dataset.level !== undefined) { setFloor(+t.dataset.level) }
  })

  function openFloor(building: string, level?: number, roomId?: string) {
    const plan = geo.floors[building]
    if (!plan) return
    clearRoute()
    focusId = null
    activeFloor = { building, level: level ?? plan.levels[0] ?? 0 }
    focusRoom = roomId ?? null
    floorBar.hidden = false
    paintFloorChips()
    applyFloor(true)
    refreshPois()
  }

  function setFloor(level: number) {
    if (!activeFloor) return
    activeFloor.level = level
    focusRoom = null
    paintFloorChips()
    applyFloor(false)
  }

  function applyFloor(fit: boolean) {
    if (!activeFloor) return
    const { building, level } = activeFloor
    const bid = buildingIdByName.get(building)
    ;(map.getSource('floor') as maplibregl.GeoJSONSource | undefined)
      ?.setData(floorFC(building, level, focusRoom ?? undefined))
    if (bid) {
      map.setFilter('building-dim', ['!=', ['get', 'id'], bid])
      map.setFilter('building-active', ['==', ['get', 'id'], bid])
      map.setPaintProperty('building-dim', 'fill-opacity', 0.5)
    }
    if (fit) {
      const feat = (geo.buildings.features ?? []).find((f) => f.properties?.name === building)
      if (feat) {
        map.fitBounds(featureBounds(feat), {
          padding: { top: 70, bottom: 150, left: 60, right: 380 },
          maxZoom: 19,
          duration: 550,
        })
      }
    }
  }

  function closeFloor() {
    activeFloor = null
    focusRoom = null
    floorBar.hidden = true
    ;(map.getSource('floor') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: [] })
    map.setFilter('building-dim', ['!=', ['get', 'id'], ''])
    map.setFilter('building-active', ['==', ['get', 'id'], ''])
    map.setPaintProperty('building-dim', 'fill-opacity', 0)
  }

  map.on('click', 'building', (e) => {
    if (drawOn) return
    const f = e.features?.[0]
    if (!f) return
    const { name, cat, levels } = f.properties as { name: string; cat: string; levels: number }
    if (geo.floors[name]) { openFloor(name); showBuilding(name, cat, levels) }
    else showBuilding(name, cat, levels)
  })
  map.on('mouseenter', 'building', () => { if (!drawOn) map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', 'building', () => { if (!drawOn) map.getCanvas().style.cursor = '' })

  // Clicking a room selects it. Rooms with a service open that service's
  // panel; empty rooms get a "trace it" hint.
  map.on('click', 'floor-fill', (e) => {
    if (drawOn || !activeFloor) return
    const p = e.features?.[0]?.properties as { id?: string; name?: string; poiId?: string } | undefined
    if (!p?.id) return
    focusRoom = p.id
    applyFloor(false)
    if (p.poiId) {
      const poi = byId.get(p.poiId)
      if (poi) showPoi(poi)
    } else {
      showRoom(p.name ?? '', activeFloor.building, activeFloor.level)
    }
  })
  map.on('mouseenter', 'floor-fill', () => { if (!drawOn) map.getCanvas().style.cursor = 'pointer' })
  map.on('mouseleave', 'floor-fill', () => { if (!drawOn) map.getCanvas().style.cursor = '' })

  /* ── routing ──────────────────────────────────────────────────────────── */

  let profile: Profile = 'foot'
  let origin: { lat: number; lon: number; label: string } | null = null
  let target: { lat: number; lon: number; label: string } | null = null
  let lastRoute: { seconds: number; metres: number } | null = null

  const badge = document.createElement('div')
  badge.id = 'route-badge'
  badge.hidden = true
  document.body.append(badge)

  function clearRoute() {
    target = null
    lastRoute = null
    badge.hidden = true
    ;(map.getSource('route') as maplibregl.GeoJSONSource | undefined)
      ?.setData({ type: 'FeatureCollection', features: [] })
  }

  function drawRoute() {
    if (!target) return
    const from = origin ?? { lat: campus.meta.center[1], lon: campus.meta.center[0], label: 'campus centre' }
    const r = router.route(from, target, profile)
    const src = map.getSource('route') as maplibregl.GeoJSONSource | undefined

    if (!r) {
      lastRoute = null
      badge.hidden = false
      badge.innerHTML = `<span>No path found on the mapped network</span>
        <button class="x" data-clear aria-label="Clear route">&times;</button>`
      src?.setData({ type: 'FeatureCollection', features: [] })
      return
    }
    lastRoute = { seconds: r.seconds, metres: r.metres }

    src?.setData({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: r.coords } }],
    })

    const notes = [
      r.steps ? 'steps' : '',
      r.unpaved ? 'unpaved shortcut' : '',
    ].filter(Boolean).join(' · ')

    badge.hidden = false
    badge.innerHTML = `
      <span class="eta">${humanEta(r.seconds)}</span>
      <span>${humanDistance(r.metres)}</span>
      <span class="mode">
        <button data-mode="foot" class="${profile === 'foot' ? 'on' : ''}">walk</button>
        <button data-mode="bike" class="${profile === 'bike' ? 'on' : ''}">cycle</button>
      </span>
      <span class="via">${origin ? '' : 'from campus centre · '}to ${escapeHtml(target.label)}${notes ? ` · ${notes}` : ''}</span>
      <button class="x" data-clear aria-label="Clear route">&times;</button>`

    map.fitBounds(bounds(r.coords), { padding: { top: 80, bottom: 110, left: 60, right: 380 }, maxZoom: 17.5 })
  }

  badge.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.dataset.clear !== undefined) { clearRoute(); return }
    if (t.dataset.mode) { profile = t.dataset.mode as Profile; drawRoute() }
  })

  function routeTo(lat: number, lon: number, label: string) {
    target = { lat, lon, label }
    drawRoute()
  }

  map.on('load', () => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords
        if (lat > 12.88 && lat < 12.91 && lon > 77.66 && lon < 77.69) {
          origin = { lat, lon, label: 'you' }
          if (target) drawRoute()
        }
      },
      () => {},
      { timeout: 6000, maximumAge: 120_000 },
    )
  })

  /* ── selection ────────────────────────────────────────────────────────── */

  function panelOffset(): [number, number] {
    return window.matchMedia('(max-width: 760px)').matches ? [0, -110] : [-140, 0]
  }

  function focusPoi(p: Poi, zoom = 17.4) {
    focusId = p.id
    refreshPois()
    map.easeTo({
      center: [p.lon, p.lat],
      zoom: Math.max(map.getZoom(), zoom),
      duration: 520,
      offset: panelOffset(),
    })
    showPoi(p)
  }

  const CLICKABLE = ['poi-dot', 'poi-label', 'poi-label-minor']

  for (const layer of CLICKABLE) {
    map.on('click', layer, (e) => {
      if (drawOn) return
      const id = e.features?.[0]?.properties?.id as string | undefined
      const p = id ? byId.get(id) : undefined
      if (p) focusPoi(p)
    })
    map.on('mouseenter', layer, () => { if (!drawOn) map.getCanvas().style.cursor = 'pointer' })
    map.on('mouseleave', layer, () => { if (!drawOn) map.getCanvas().style.cursor = '' })
  }

  /* ── search ───────────────────────────────────────────────────────────── */

  const index = new SearchIndex(campus, {
    onLayer: (cat) => {
      active.has(cat) && active.size === 1 ? active.clear() : active.add(cat)
      refreshPois()
    },
    onAction: (id) => {
      if (id === 'layers-all') { cats.forEach(([c]) => active.add(c)); refreshPois() }
      if (id === 'layers-none') { active.clear(); refreshPois() }
      if (id === 'clear-route') clearRoute()
      if (id === 'about') showAbout(campus)
      if (id === 'locate') {
        navigator.geolocation?.getCurrentPosition((pos) =>
          map.easeTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 17 }))
      }
    },
  })

  function openHit(hit: Hit) {
    if (hit.run) { hit.run(); return }

    // A room opens its building on the right floor, focused.
    if (hit.kind === 'room' && hit.building != null) {
      openFloor(hit.building, hit.level ?? 0, hit.roomId)
      const room = campus.rooms?.find((r) => r.id === hit.roomId)
      const poi = room?.poiId ? byId.get(room.poiId) : undefined
      if (poi) showPoi(poi)
      else if (room) showRoom(room.name, room.building, room.level)
      return
    }

    if (hit.kind === 'place' && hit.poi) {
      const p = hit.poi
      if (p.building && p.level != null) {
        openFloor(p.building, p.level, p.room)
        showPoi(p)
        return
      }
      focusPoi(p)
      return
    }
  }

  initPanel({
    campus,
    routeTo,
    routeState: () => ({
      active: !!target,
      eta: lastRoute?.seconds,
      metres: lastRoute?.metres,
    }),
    close: () => { focusId = null; refreshPois() },
  })

  initPalette({
    index,
    campus,
    open: openHit,
    routeTo: (hit) => { if (hit.lat != null) routeTo(hit.lat, hit.lon!, hit.title) },
  })

  /* ── chrome ───────────────────────────────────────────────────────────── */

  document.getElementById('brand-btn')!.addEventListener('click', () => showAbout(campus))

  /* ── theme ────────────────────────────────────────────────────────────── */

  const themeBtn = document.getElementById('theme-btn')!
  const paintThemeBtn = () => {
    const dark = resolved() === 'dark'
    themeBtn.textContent = dark ? '☾' : '☀'
    themeBtn.title = dark ? 'Switch to light' : 'Switch to dark'
  }
  paintThemeBtn()
  themeBtn.addEventListener('click', () => { toggleTheme(); paintThemeBtn() })

  onThemeChange((t) => {
    shadeCache.clear()
    paintRail()
    map.setStyle(buildStyle(geo, campus, t, base))
    map.once('styledata', () => {
      refreshPois()
      if (target) drawRoute()
      if (activeFloor) applyFloor(false)
      // setStyle rebuilds the style, which resets every layer state — the
      // satellite toggle must be re-applied just like the floor view is.
      setSatellite(satOn)
      // The draw plugin adds its layers to the style; after a rebuild they
      // are gone, so re-attach the control to bring them back. The re-attach
      // builds a fresh store, so save the drafts first and put them back —
      // a theme switch must not discard unsaved work.
      if (draw) {
        const saved = draw.getAll().features
        try { map.removeControl(draw) } catch { /* not added */ }
        map.addControl(draw, 'top-left')
        for (const f of saved) {
          try { draw.add(f) } catch { /* noop */ }
        }
      }
    })
  })

  /* ── satellite basemap ───────────────────────────────────────────────── */

  // Optional ESRI World Imagery beneath the curated layers. Off by default so
  // the map stays fully offline and self-drawn; the toggle is the only feature
  // that loads external tiles. The choice is remembered per browser.
  const SAT_KEY = 'campusmap.sat'
  let satOn = false
  try { satOn = localStorage.getItem(SAT_KEY) === '1' } catch { /* storage off */ }

  const satBtn = document.getElementById('sat-btn')!
  const satAttrib = document.getElementById('sat-attrib')!

  // Ground fills that would hide the imagery. Guarded with getLayer so the
  // list can grow without touching this code again.
  const GROUND_FILLS = ['campus', 'green', 'water', 'waterway']

  function setSatellite(on: boolean) {
    satOn = on
    satAttrib.hidden = !on
    satBtn.setAttribute('aria-pressed', String(on))
    satBtn.classList.toggle('on', on)
    if (!map.getLayer('sat')) return
    map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none')
    for (const id of GROUND_FILLS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'none' : 'visible')
    }
    // Translucent building fills so rooftops show through the imagery.
    map.setPaintProperty('building', 'fill-opacity', on ? (resolved() === 'dark' ? 0.25 : 0.35) : 1)
  }

  satBtn.addEventListener('click', () => {
    const next = !satOn
    try { localStorage.setItem(SAT_KEY, next ? '1' : '0') } catch { /* storage off */ }
    setSatellite(next)
  })

  /* ── draw mode ───────────────────────────────────────────────────────── */

  // Trace shapes straight onto the map (the satellite toggle helps) and save
  // them into data/curated/*.geojson through the dev server. Dev-only: the
  // button stays disabled unless GET /curated/buildings.geojson answers,
  // which only the local dev middleware serves.
  //
  // Drawing is powered by maplibre-gl-draw. Click to add points; Enter or
  // double-click finishes a shape; Esc cancels it. Finished shapes stay in
  // the editor until saved: click one to select it, double-click it to edit
  // its points (drag vertices, drag the midpoint handles on the outline to
  // insert points, Alt+click anywhere on the shape to insert a vertex there,
  // Alt+click a vertex to delete it). Middle-drag pans the map at any time.
  type DrawLayer = 'boundary' | 'building' | 'path' | 'poi' | 'room'
  interface Draft {
    id: number
    /** Feature id inside the MapboxDraw store — keeps the map and the list in sync. */
    featureId: string
    file: string
    kind: 'polygon' | 'line' | 'point'
    geometry: GeoJSON.Geometry
    props: Record<string, string | number>
    label: string
  }

  const drawBtn = document.getElementById('draw-btn') as HTMLButtonElement
  const drawToolbar = document.getElementById('draw-toolbar')!

  const DRAW_FILE: Record<DrawLayer, string> = {
    boundary: 'boundary.geojson',
    building: 'buildings.geojson',
    path: 'paths.geojson',
    poi: 'pois.geojson',
    room: 'indoor.geojson',
  }
  const DRAW_GEOM: Record<DrawLayer, 'polygon' | 'line' | 'point'> = {
    boundary: 'polygon', building: 'polygon', path: 'line', poi: 'point', room: 'polygon',
  }
  const DRAW_LABELS: Record<DrawLayer, string> = {
    boundary: 'Boundary', building: 'Building', path: 'Path', poi: 'POI', room: 'Room',
  }
  const FILE_LABEL: Record<string, string> = {
    'boundary.geojson': 'boundary', 'buildings.geojson': 'building', 'paths.geojson': 'path',
    'pois.geojson': 'poi', 'indoor.geojson': 'room',
  }
  const MODE_FOR: Record<DrawLayer, string> = {
    boundary: 'draw_polygon', building: 'draw_polygon', path: 'draw_line_string',
    poi: 'draw_point', room: 'draw_polygon',
  }
  const DRAW_HINTS: Record<DrawLayer, string> = {
    boundary: 'Click along the campus wall. One polygon per parcel — the hostel block across the road is a second polygon.',
    building: 'Click the building corners.',
    path: 'Click the path ends. Shared joints must reuse the same point.',
    poi: 'Click where the place is.',
    room: 'Click the room corners. Rooms on one floor must not overlap.',
  }
  const EDIT_HINT = 'Enter or double-click finishes · Esc cancels · double-click a draft to edit its points · Alt+click a segment adds a point · Alt+click a point removes it'

  let draw: MapboxDraw | null = null
  let drawOn = false
  let drawLayer: DrawLayer = 'building'
  let drafts: Draft[] = []
  let pendingForm: { featureId: string; layer: DrawLayer; geometry: GeoJSON.Geometry } | null = null
  let nextDraftId = 1
  let drawingBusy = false

  function setDrawMsg(msg: string) {
    const m = drawToolbar.querySelector('.dt-msg')
    if (m) m.textContent = msg
  }

  function catOptions(selected = ''): string {
    return Object.entries(campus.categories)
      .map(([k, c]) => `<option value="${k}"${k === selected ? ' selected' : ''}>${c.label}</option>`)
      .join('')
  }

  function propsFormHtml(layer: DrawLayer): string {
    const actions = '<div class="dt-form-actions"><button type="submit">Add to map</button>' +
      '<button type="button" data-dt-form-cancel>Discard</button></div>'
    switch (layer) {
      case 'building':
        return `<form class="dt-form">
          <label>Name <input name="name" required placeholder="e.g. Admin Block"></label>
          <label>Category <select name="cat"><option value="">none</option>${catOptions()}</select></label>
          <label>Levels <input name="levels" type="number" min="1" value="1"></label>
          ${actions}</form>`
      case 'boundary':
        return `<form class="dt-form">
          <label>Name <input name="name" value="Amrita Vishwa Vidyapeetam, Bengaluru"></label>
          <p class="dt-warn">One polygon per parcel — draw the hostel block as a second boundary polygon.</p>
          ${actions}</form>`
      case 'path':
        return `<form class="dt-form">
          <label>Kind <select name="kind"><option value="path">path</option><option value="road">road</option><option value="steps">steps</option></select></label>
          <label>Surface <select name="surface"><option value="">unknown</option><option value="paved">paved</option><option value="unpaved">unpaved</option></select></label>
          ${actions}</form>`
      case 'poi':
        return `<form class="dt-form">
          <label>Name <input name="name" required placeholder="e.g. Main Gate"></label>
          <label>Category <select name="cat" required><option value="">choose…</option>${catOptions()}</select></label>
          <label>Building <input name="building" list="dt-building-list" placeholder="optional — indoor place"></label>
          <label>Floor <input name="level" type="number" min="0" placeholder="0 = ground"></label>
          ${actions}</form>`
      case 'room':
        return `<form class="dt-form">
          <label>Building <input name="building" list="dt-building-list" required placeholder="exact building name"></label>
          <label>Floor <input name="level" type="number" min="0" required placeholder="0 = ground"></label>
          <label>Room <input name="room" required placeholder="e.g. Room 203"></label>
          <label>Kind <select name="kind"><option value="room">room</option><option value="corridor">corridor</option><option value="stairs">stairs</option><option value="lift">lift</option><option value="toilet">toilet</option></select></label>
          ${actions}</form>`
    }
  }

  function paintDrawToolbar() {
    if (!drawOn) { drawToolbar.hidden = true; return }
    drawToolbar.hidden = false
    const chips = (Object.keys(DRAW_LABELS) as DrawLayer[])
      .map((l) => `<button type="button" data-dl="${l}" class="${l === drawLayer ? 'on' : ''}">${DRAW_LABELS[l]}</button>`)
      .join('')
    const formHtml = pendingForm ? propsFormHtml(pendingForm.layer) : ''
    const placing = draw?.getMode().startsWith('draw_') ?? false
    const draftsHtml = drafts.length
      ? `<ul class="dt-drafts">${drafts.map((d) =>
          `<li><span class="dt-tag">${FILE_LABEL[d.file] ?? d.file}</span>` +
          `<span class="dt-name">${escapeHtml(d.label)}</span>` +
          `<button type="button" class="x" data-dt-del="${d.id}" aria-label="Delete draft">&times;</button></li>`).join('')}</ul>`
      : ''
    drawToolbar.innerHTML =
      `<div class="dt-head"><span class="dt-title">Draw</span>` +
      `<button type="button" class="x" data-dt-close aria-label="Close draw mode">&times;</button></div>` +
      `<div class="dt-layers">${chips}</div>` +
      `<p class="dt-hint">${DRAW_HINTS[drawLayer]}<br><span class="dt-sub">${EDIT_HINT}</span></p>` +
      (pendingForm ? formHtml
        : placing
          ? '<p class="dt-mode">Placing points… Enter or double-click to finish.</p>'
          : '<p class="dt-mode">Pick a layer chip to start drawing. Double-click a draft to edit its points.</p>') +
      draftsHtml +
      `<div class="dt-save"><button type="button" data-dt-save ${drafts.length ? '' : 'disabled'}>Save ${drafts.length}</button>` +
      `<span class="dt-msg"></span></div>`
  }

  /** Update only the mode hint — never repaint the whole toolbar while a
   *  property form is open, or the user's typed input would be wiped. */
  function paintDrawMode() {
    if (!drawOn) return
    const el = drawToolbar.querySelector('.dt-mode')
    if (!el) return
    el.textContent = draw?.getMode().startsWith('draw_') ?? false
      ? 'Placing points… Enter or double-click to finish.'
      : 'Pick a layer chip to start drawing. Double-click a draft to edit its points.'
  }

  function ensureDraw(): MapboxDraw {
    if (!draw) {
      draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: 'simple_select',
      })
      map.addControl(draw, 'top-left')
      draw.on('draw.create', onDrawCreate)
      draw.on('draw.update', onDrawUpdate)
      draw.on('draw.delete', onDrawDelete)
      draw.on('draw.modechange', () => paintDrawMode())
    }
    return draw
  }

  function startDraw() {
    drawOn = true
    drawBtn.setAttribute('aria-pressed', 'true')
    drawBtn.classList.add('on')
    map.getCanvas().style.cursor = 'crosshair'
    map.doubleClickZoom.disable()
    ensureDraw().changeMode(MODE_FOR[drawLayer])
    paintDrawToolbar()
  }

  function stopDraw() {
    drawOn = false
    if (pendingForm) discardPending()
    const mode = draw?.getMode() ?? ''
    if (mode.startsWith('draw_')) cancelCurrentShape()
    drawBtn.setAttribute('aria-pressed', 'false')
    drawBtn.classList.remove('on')
    map.getCanvas().style.cursor = ''
    map.doubleClickZoom.enable()
    drawToolbar.hidden = true
    // Drafts stay in the editor (and on the map) until they are saved or the
    // page reloads — reopening draw mode shows the list again.
  }

  function onDrawCreate(e: { features?: GeoJSON.Feature[] }) {
    if (!drawOn || !draw) return
    const f = e.features?.[0]
    if (!f?.id || !f.geometry) return
    // A re-add (Alt+click insert) keeps its _draft tag — do not re-open a form.
    if (f.properties?.['_draft'] === true) return
    // A form still open belongs to an earlier shape the user never finished
    // filling in — discard that shape instead of orphaning it.
    if (pendingForm) discardPending()
    const id = String(f.id)
    draw.setFeatureProperty(id, '_draft', true)
    pendingForm = { featureId: id, layer: drawLayer, geometry: f.geometry }
    paintDrawToolbar()
  }

  function onDrawUpdate(e: { features?: GeoJSON.Feature[] }) {
    if (!drawOn) return
    for (const f of e.features ?? []) {
      if (!f?.id || !f.geometry) continue
      const d = drafts.find((x) => x.featureId === String(f.id))
      if (d) d.geometry = f.geometry
    }
  }

  function onDrawDelete(e: { features?: GeoJSON.Feature[] }) {
    const ids = new Set((e.features ?? []).map((f) => String(f?.id)))
    if (!ids.size) return
    drafts = drafts.filter((d) => !ids.has(d.featureId))
    paintDrawToolbar()
  }

  function discardPending() {
    if (!pendingForm) return
    const id = pendingForm.featureId
    pendingForm = null
    try { draw?.delete(id) } catch { /* already gone */ }
    paintDrawToolbar()
  }

  /** The newest shape of the current draw mode that is not a finished draft. */
  function inProgressShape(): GeoJSON.Feature | undefined {
    if (!draw) return undefined
    const want = { draw_polygon: 'Polygon', draw_line_string: 'LineString', draw_point: 'Point' }[draw.getMode()]
    if (!want) return undefined
    const feats = draw.getAll().features
    for (let i = feats.length - 1; i >= 0; i--) {
      const f = feats[i]
      if (!f || !f.id || f.geometry?.type !== want) continue
      if (drafts.some((d) => d.featureId === String(f.id))) continue
      return f
    }
    return undefined
  }

  /** Finish the current shape (Enter or double-click). */
  function finishCurrentShape() {
    if (pendingForm || !draw) return
    const f = inProgressShape()
    if (!f?.id) return
    const g = f.geometry
    if (g.type === 'Polygon') {
      const ring = g.coordinates[0]
      if (!ring) return
      const a = ring[0], b = ring[ring.length - 1]
      // In-progress rings are open (last point != first) and need 3+ corners.
      if (ring.length < 4 || (a && b && a[0] === b[0] && a[1] === b[1])) return
    } else if (g.type === 'LineString') {
      if (g.coordinates.length < 3) return // trailing duplicate; need 2+ real points
    } else {
      return
    }
    draw.changeMode('simple_select', { featureIds: [String(f.id)] })
  }

  /** Cancel the current shape without creating anything (Esc). */
  function cancelCurrentShape() {
    const f = inProgressShape()
    if (f?.id) { try { draw?.delete(String(f.id)) } catch { /* noop */ } }
    draw?.changeMode('simple_select')
  }

  function labelFor(layer: DrawLayer, props: Record<string, string | number>): string {
    if (layer === 'room') return String(props.room)
    if (layer === 'path') return `${props.kind} path`
    return String(props.name)
  }

  drawToolbar.addEventListener('submit', (e) => {
    e.preventDefault()
    if (!pendingForm) return
    const form = e.target as HTMLFormElement
    const fd = new FormData(form)
    const get = (k: string) => String(fd.get(k) ?? '').trim()
    const layer = pendingForm.layer
    const props: Record<string, string | number> = {}

    switch (layer) {
      case 'building': {
        const name = get('name')
        if (!name) { setDrawMsg('Name is required.'); return }
        const cat = get('cat')
        if (cat && !campus.categories[cat]) { setDrawMsg('Unknown category.'); return }
        props.name = name
        if (cat) props.cat = cat
        props.levels = Math.max(1, Math.round(+get('levels')) || 1)
        break
      }
      case 'boundary':
        props.name = get('name') || 'Amrita Vishwa Vidyapeetam, Bengaluru'
        break
      case 'path':
        props.kind = get('kind') || 'path'
        if (get('surface')) props.surface = get('surface')
        break
      case 'poi': {
        const name = get('name')
        const cat = get('cat')
        if (!name) { setDrawMsg('Name is required.'); return }
        if (!cat || !campus.categories[cat]) { setDrawMsg('Choose a category.'); return }
        props.name = name
        props.cat = cat
        const b = get('building')
        if (b) {
          if (get('level') === '') { setDrawMsg('Floor is required when the place is inside a building.'); return }
          props.building = b
          props.level = Math.round(+get('level'))
        }
        break
      }
      case 'room': {
        const building = get('building')
        const room = get('room')
        if (!building || get('level') === '' || !room) {
          setDrawMsg('Building, floor and room name are required.')
          return
        }
        props.building = building
        props.level = Math.round(+get('level'))
        props.room = room
        props.kind = get('kind') || 'room'
        break
      }
    }

    // Take the geometry from the editor — vertices may have moved while the
    // form was open.
    const feat = draw?.get(pendingForm.featureId)
    const geometry = feat?.geometry ?? pendingForm.geometry
    drafts.push({
      id: nextDraftId++,
      featureId: pendingForm.featureId,
      file: DRAW_FILE[layer],
      kind: DRAW_GEOM[layer],
      geometry,
      props,
      label: labelFor(layer, props),
    })
    pendingForm = null
    paintDrawToolbar()
    setDrawMsg('')
  })

  drawToolbar.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-dt-close]')) { stopDraw(); return }
    if (t.closest('[data-dt-form-cancel]')) { discardPending(); return }
    const dl = t.closest('[data-dl]') as HTMLElement | null
    if (dl) {
      // A shape in progress belongs to the current layer — switching now would
      // let the plugin's finish event stamp it with the new layer's file.
      // Finish or cancel the shape before picking another layer.
      const mode = draw?.getMode() ?? ''
      if (drawOn && (mode === 'draw_polygon' || mode === 'draw_line_string' || mode === 'draw_point')) {
        setDrawMsg('Finish or cancel the current shape first.')
        return
      }
      // An open form owns a shape in the store — drop it rather than orphan it.
      if (pendingForm) discardPending()
      drawLayer = dl.dataset.dl as DrawLayer
      if (drawOn) ensureDraw().changeMode(MODE_FOR[drawLayer])
      paintDrawToolbar()
      return
    }
    const del = t.closest('[data-dt-del]') as HTMLElement | null
    if (del) {
      const d = drafts.find((x) => x.id === +del.dataset['dt-del']!)
      if (d) {
        drafts = drafts.filter((x) => x.id !== d.id)
        try { draw?.delete(d.featureId) } catch { /* already gone */ }
        paintDrawToolbar()
      }
      return
    }
    if (t.closest('[data-dt-save]')) void saveDrafts()
  })

  // Double-click finishes the in-progress shape. The plugin's own double-click
  // adds a vertex (or closes a polygon when it lands on the first vertex); we
  // step in after that so the second click of the pair never leaves a stray
  // point, matching how the old custom editor behaved. Middle-button
  // double-clicks are pan gestures, not finish gestures.
  map.on('dblclick', (e) => {
    if (drawOn && e.originalEvent?.button !== 1) finishCurrentShape()
  })

  // Alt+click on a selected shape edits it in place: clicking a point removes
  // that point, clicking anywhere else on the shape inserts a vertex on the
  // nearest segment — covering "add points inside the area already traced"
  // without having to drag the outline around first.
  function nearestSegmentInsert(p: [number, number], coords: [number, number][]) {
    let best: { i: number; x: number; y: number } | null = null
    let bestD = Infinity
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1]
      if (!a || !b) continue
      const abx = b[0] - a[0], aby = b[1] - a[1]
      const len2 = abx * abx + aby * aby
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2))
      const x = a[0] + t * abx, y = a[1] + t * aby
      const d = Math.hypot(p[0] - x, p[1] - y)
      if (d < bestD) { bestD = d; best = { i, x, y } }
    }
    return best
  }

  /** Alt+click near a vertex of the selected shape removes it. Returns the
   *  feature with the vertex deleted, or null when the click is not near a
   *  vertex or the shape would fall below the minimum point count. */
  function deletedVertexFeature(
    e: maplibregl.MapMouseEvent,
    feat: GeoJSON.Feature,
    coords: [number, number][],
  ): GeoJSON.Feature | null {
    const g = feat.geometry
    const ring = g.type === 'Polygon'
    if (!ring && g.type !== 'LineString') return null
    // Polygon rings from the plugin are closed — the last point duplicates
    // the first, so it is not a vertex of its own.
    const real = ring ? coords.slice(0, -1) : coords
    let bestIdx = -1
    let bestD = Infinity
    for (let i = 0; i < real.length; i++) {
      const c = real[i]
      if (!c) continue
      const sp = map.project([c[0], c[1]])
      const d = Math.hypot(sp.x - e.point.x, sp.y - e.point.y)
      if (d < bestD) { bestD = d; bestIdx = i }
    }
    if (bestIdx < 0 || bestD > 12) return null
    // Keep at least 3 corners for a polygon, 2 points for a line.
    if (real.length - 1 < (ring ? 3 : 2)) return null
    const next = real.slice(0, bestIdx).concat(real.slice(bestIdx + 1))
    return ring
      ? { ...feat, geometry: { type: 'Polygon', coordinates: [next.concat([next[0]!])] } }
      : { ...feat, geometry: { type: 'LineString', coordinates: next } }
  }

  map.on('click', (e) => {
    if (!drawOn || !draw || draw.getMode() !== 'direct_select') return
    if (!e.originalEvent.altKey) return
    const sel = draw.getSelected()
    const feat = sel.features?.[0]
    if (!feat?.id || !feat.geometry) return
    const id = String(feat.id)
    const g = feat.geometry
    const coords = g.type === 'Polygon' ? g.coordinates[0] : g.type === 'LineString' ? g.coordinates : null
    if (!coords) return

    // Alt+click on a point deletes it; the point must be close enough to
    // count as the intended target rather than an insert on a nearby segment.
    const deleted = deletedVertexFeature(e, feat, coords as [number, number][])
    if (deleted) {
      draw.add(deleted)
      const d = drafts.find((x) => x.featureId === id)
      if (d) d.geometry = deleted.geometry
      return
    }

    // Otherwise the click must land on the shape itself — fills for polygons,
    // the line for paths — not just anywhere on the map.
    const drawLayers = map.getStyle().layers
      .filter((l) => l.id?.startsWith('gl-draw-') && (l.id.includes('fill') || l.id.includes('line') || l.id.includes('stroke')))
      .map((l) => l.id)
    if (!drawLayers.length) return
    // Query a small box around the click so thin line strokes are hittable.
    const hit = map.queryRenderedFeatures(
      [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]],
      { layers: drawLayers },
    )
      .find((h) => String(h.properties?.id) === id)
    if (!hit) return
    const best = nearestSegmentInsert([e.lngLat.lng, e.lngLat.lat], coords as [number, number][])
    if (!best) return
    const nx = +best.x.toFixed(6), ny = +best.y.toFixed(6)
    const next = coords.slice()
    next.splice(best.i + 1, 0, [nx, ny])
    const updated: GeoJSON.Feature = g.type === 'Polygon'
      ? { ...feat, geometry: { type: 'Polygon', coordinates: [next] } }
      : { ...feat, geometry: { type: 'LineString', coordinates: next } }
    draw.add(updated)
    const d = drafts.find((x) => x.featureId === id)
    if (d) d.geometry = updated.geometry
  })

  async function saveDrafts() {
    if (!drafts.length || drawingBusy) return
    drawingBusy = true
    setDrawMsg('Saving…')
    const saveBtn = drawToolbar.querySelector('[data-dt-save]') as HTMLButtonElement | null
    if (saveBtn) saveBtn.disabled = true

    const byFile = new Map<string, Draft[]>()
    for (const d of drafts) {
      const arr = byFile.get(d.file) ?? []
      arr.push(d)
      byFile.set(d.file, arr)
    }

    const errors: string[] = []
    for (const [file, list] of byFile) {
      try {
        const res = await fetch(`${base}curated/${file}`)
        if (!res.ok) { errors.push(`${file}: could not load existing data`); continue }
        const existing = await res.json() as GeoJSON.FeatureCollection
        const merged: GeoJSON.FeatureCollection = {
          ...existing,
          type: 'FeatureCollection',
          features: [
            ...(existing.features ?? []),
            ...list.map((d) => ({ type: 'Feature' as const, properties: d.props, geometry: d.geometry })),
          ],
        }
        const save = await fetch(`${base}api/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file, data: merged }),
        })
        const out = await save.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (!save.ok || out.ok !== true) errors.push(`${file}: ${out.error ?? `HTTP ${save.status}`}`)
      } catch (err) {
        errors.push(`${file}: ${(err as Error).message}`)
      }
    }

    drawingBusy = false
    if (errors.length) {
      setDrawMsg(`Save failed — ${errors.join(' · ')}`)
      if (saveBtn) saveBtn.disabled = false
      return
    }
    setDrawMsg('Saved — reloading…')
    setTimeout(() => location.reload(), 800)
  }

  drawBtn.addEventListener('click', () => { if (drawOn) stopDraw(); else startDraw() })

  /* ── middle-click pan ─────────────────────────────────────────────────── */
  // Browsers reserve middle-button drag for autoscroll, and MapLibre only
  // pans with the left button. While drawing, left-click places points, so a
  // middle-drag is the natural way to move the map without adding vertices.
  let midDrag: { x: number; y: number } | null = null
  map.getContainer().addEventListener('mousedown', (e) => {
    if (e.button !== 1) return
    e.preventDefault() // kill the browser autoscroll
    // Stop the event reaching MapLibre/plugin: otherwise the middle-button
    // mousedown+up pair would be read as a click and a stationary middle
    // click would add a stray vertex while drawing.
    e.stopImmediatePropagation()
    midDrag = { x: e.clientX, y: e.clientY }
  }, true)
  window.addEventListener('mousemove', (e) => {
    if (!midDrag) return
    const dx = e.clientX - midDrag.x
    const dy = e.clientY - midDrag.y
    if (dx === 0 && dy === 0) return
    midDrag = { x: e.clientX, y: e.clientY }
    map.panBy([-dx, -dy], { duration: 0 })
  })
  const endMidDrag = () => { midDrag = null }
  window.addEventListener('mouseup', endMidDrag)
  window.addEventListener('blur', endMidDrag)

  // The draw tool only exists behind the dev server: probe the curated file
  // endpoint and enable the button when it answers. The deployed site (and
  // any static preview) never enables it.
  void (async () => {
    try {
      const res = await fetch(`${base}curated/buildings.geojson`)
      if (!res.ok) return
      const data = await res.json() as { features?: { properties?: { name?: string } }[] }
      const names = (data.features ?? []).map((f) => f.properties?.name ?? '').filter(Boolean)
      const dl = document.createElement('datalist')
      dl.id = 'dt-building-list'
      dl.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}">`).join('')
      document.body.append(dl)
      drawBtn.disabled = false
    } catch { /* deployed site — draw stays disabled */ }
  })()

  document.getElementById('brand-btn')!.title =
    `${campus.pois.length} places · ${campus.rooms?.length ?? 0} rooms — click for sources`

  document.addEventListener('keydown', (e) => {
    if (drawOn) {
      if (e.key === 'Escape') {
        if (pendingForm) { discardPending(); return }
        const mode = draw?.getMode() ?? ''
        if (mode === 'draw_polygon' || mode === 'draw_line_string' || mode === 'draw_point') {
          cancelCurrentShape()
          return
        }
        stopDraw()
        return
      }
      if (e.key === 'Enter' && !pendingForm) {
        const tag = (e.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
        // The plugin finishes shapes itself when the canvas has focus (it
        // handles keyup there); only step in when focus is elsewhere.
        if ((e.target as Element | null)?.classList?.contains('maplibregl-canvas')) return
        finishCurrentShape()
        return
      }
      return
    }
    if (e.key !== 'Escape' || !document.getElementById('palette')!.hidden) return
    if (rail.classList.contains('open')) { closeLayers(); return }
    if (activeFloor) { closeFloor(); hidePanel(); return }
    hidePanel(); focusId = null; refreshPois()
  })

  // A style or asset failure otherwise leaves the boot overlay up forever.
  const bootTimer = setTimeout(() => {
    if (boot.classList.contains('gone')) return
    boot.className = 'err'
    boot.textContent = 'The map did not finish loading. Check the browser console — and please open an issue at github.com/nithitsuki/map.amrita.town.'
  }, 12_000)

  map.on('error', (e) => {
    console.error('[map]', e.error?.message ?? e)
  })

  map.on('load', () => {
    clearTimeout(bootTimer)
    refreshPois()
    setSatellite(satOn)
    boot.classList.add('gone')
    const params = new URLSearchParams(location.search)
    const id = params.get('id')
    const q = params.get('q')
    if (id && byId.has(id)) {
      const p = byId.get(id)!
      // Indoor POIs have no dot — open their building+floor and focus the room.
      if (p.building && p.level != null) {
        openFloor(p.building, p.level, p.room)
        showPoi(p)
      } else {
        focusPoi(p)
      }
    }
    else if (q) openPalette(q)
  })
}

function featureBounds(f: GeoJSON.Feature): [[number, number], [number, number]] {
  const g = f.geometry as GeoJSON.Polygon | null
  const ring = (g?.coordinates?.[0] ?? []) as unknown as [number, number][]
  let w = 180, s = 90, e = -180, n = -90
  for (const [lon, lat] of ring) {
    w = Math.min(w, lon); e = Math.max(e, lon)
    s = Math.min(s, lat); n = Math.max(n, lat)
  }
  return [[w, s], [e, n]]
}

function bounds(coords: [number, number][]): [[number, number], [number, number]] {
  let w = 180, s = 90, e = -180, n = -90
  for (const [lon, lat] of coords) {
    w = Math.min(w, lon); e = Math.max(e, lon)
    s = Math.min(s, lat); n = Math.max(n, lat)
  }
  return [[w, s], [e, n]]
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

start().catch((err) => {
  console.error(err)
  boot.className = 'err'
  boot.textContent = `Could not load campus data — ${err.message}. Run \`bun run build:data\` and reload.`
})
