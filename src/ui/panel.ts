import type { Campus, Poi } from '../types'
import { openNow } from '../search/hours'
import { humanDistance, humanEta } from '../route/router'

const el = document.getElementById('panel') as HTMLElement

export const REPO = 'https://github.com/amritadottown/map.amrita.town'

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export interface PanelHost {
  campus: Campus
  routeTo(lat: number, lon: number, label: string): void
  routeState(): { active: boolean; eta?: number; metres?: number }
  close(): void
}

let host: PanelHost

export function initPanel(h: PanelHost) {
  host = h
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    if (t.closest('.p-close')) { hidePanel(); host.close() }
    const r = t.closest('[data-route]') as HTMLElement | null
    if (r) host.routeTo(+r.dataset.lat!, +r.dataset.lon!, r.dataset.label!)
  })
}

export function hidePanel() { el.hidden = true }

function shell(title: string, kind: string, body: string) {
  el.hidden = false
  el.innerHTML = `
    <div class="p-grip" aria-hidden="true"></div>
    <div class="p-head">
      <div>
        <h2>${esc(title)}</h2>
        <div class="p-kind">${esc(kind)}</div>
      </div>
      <button class="p-close" aria-label="close">&times;</button>
    </div>
    <div class="p-body">${body}</div>`
  el.querySelector('.p-body')!.scrollTop = 0
}

function kv(rows: [string, string | undefined][]) {
  const live = rows.filter(([, v]) => v)
  if (!live.length) return ''
  return `<dl class="kv">${live.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`
}

function hoursRow(spec?: string): string | undefined {
  if (!spec) return undefined
  const st = openNow(spec)
  const badge = st === null ? ''
    : st.open ? ` <span class="open">· open${st.until ? ` till ${st.until}` : ''}</span>`
    : ` <span class="shut">· closed${st.next ? ` · opens ${st.next}` : ''}</span>`
  return `${esc(spec)}${badge}`
}

function routeButtons(lat: number, lon: number, label: string) {
  const s = host.routeState()
  return `<div class="p-actions">
    <button data-route data-lat="${lat}" data-lon="${lon}" data-label="${esc(label)}"
      class="${s.active ? 'on' : ''}">${s.active && s.eta != null
        ? `${humanEta(s.eta)} · ${humanDistance(s.metres!)}`
        : 'route here'}</button>
  </div>`
}

export function floorLabel(level: number): string {
  return level === 0 ? 'ground floor' : `floor ${level}`
}

/* ── places ──────────────────────────────────────────────────────────────── */

export function showPoi(p: Poi) {
  const cat = host.campus.categories[p.cat]
  const wheel = p.wheelchair === 'yes' ? 'step-free'
    : p.wheelchair === 'limited' ? 'limited'
    : p.wheelchair === 'no' ? 'not step-free' : undefined

  const body = [
    routeButtons(p.lat, p.lon, p.name),
    kv([
      ['building', p.building ? esc(p.building) : undefined],
      ['floor', p.level != null ? esc(floorLabel(p.level)) : undefined],
      ['hours', hoursRow(p.hours)],
      ['access', wheel ? esc(wheel) : undefined],
      ['type', p.kind ? esc(p.kind.replace(/_/g, ' ')) : undefined],
      ['phone', p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : undefined],
      ['website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : undefined],
    ]),
    p.desc ? `<p class="p-note">${esc(p.desc)}</p>` : '',
    p.building ? `<p class="p-note">indoor places have no pin on the map — the room
      containing this place glows brighter on its floor plan instead.</p>` : '',
    `<p class="src">verify before relying on it</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, body)
}

/* ── buildings & rooms ───────────────────────────────────────────────────── */

export function showBuilding(name: string, cat: string, levels: number) {
  const meta = host.campus.categories[cat]
  const body = [
    kv([
      ['category', meta ? esc(meta.label) : undefined],
      ['floors', `${levels}`],
    ]),
    levels > 1
      ? `<p class="p-note">click the map on this building to open its floor plan.
         rooms glow where a service is listed; the focused room is brightest.</p>`
      : `<p class="p-note">no indoor floor plan is mapped yet. trace one in
         <code>data/curated/indoor.geojson</code> and it appears here on the next build.</p>`,
  ].join('')

  shell(name, meta?.label ?? cat, body)
}

export function showRoom(name: string, building: string, level: number) {
  const body = [
    kv([
      ['building', esc(building)],
      ['floor', esc(floorLabel(level))],
    ]),
    `<p class="p-note">no service is listed for this room yet. add one in
       <code>data/curated/pois.geojson</code> with the room's building and floor,
       and this room will glow on its floor plan.</p>`,
  ].join('')

  shell(name, `${building} · ${floorLabel(level)}`, body)
}

/* ── about ───────────────────────────────────────────────────────────────── */

export function showAbout(campus: Campus) {
  const total = Object.values(campus.meta.counts).reduce((a, b) => a + b, 0)
  const indoor = campus.pois.filter((p) => p.building).length
  const rooms = campus.rooms?.length ?? 0

  const body = `
    <div class="p-sec">map & places</div>
    <p class="p-note"><strong>${total}</strong> places (${indoor} indoors), <strong>${rooms}</strong> rooms across
    <strong>${Object.keys(campus.meta.counts).length}</strong> categories. walking times are computed
    over the traced path network.</p>

    <div class="p-sec">multi-floor</div>
    <p class="p-note">click a building with more than one floor to open its floor
    plan. indoor places have no pins — the room that contains one glows brighter,
    and the rest of the floor stays dimmer.</p>

    ${campus.meta.sample
      ? `<div class="p-sec">sample data</div>
         <p class="p-note">this build uses <strong>sample data</strong>. replace the files in
         <code>data/curated/</code> with your own traces before sharing the map.
         see the README for the geojson.io workflow.</p>`
      : ''}

    <div class="p-sec">contribute</div>
    <p class="p-note">something wrong or missing? trace it at
    <a href="https://geojson.io" target="_blank" rel="noopener">geojson.io</a>,
    drop the file into <code>data/curated/</code>, and rebuild. full instructions in the
    <a href="${REPO}#readme" target="_blank" rel="noopener">README</a>.</p>

    <p class="src">built ${esc(campus.meta.built)} · ${esc(campus.meta.attribution)}
    · <a href="${REPO}" target="_blank" rel="noopener">source</a></p>`

  shell('amrita.town', 'about & data sources', body)
}
