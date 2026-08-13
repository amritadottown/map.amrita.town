import type { Campus, Poi } from '../types'
import { openNow } from '../search/hours'
import { humanDistance, humanEta } from '../route/router'

const el = document.getElementById('panel') as HTMLElement

export const REPO = 'https://github.com/nithitsuki/map.amrita.town'

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
      <button class="p-close" aria-label="Close">&times;</button>
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
    : st.open ? ` <span style="color:#7ee787">· open${st.until ? ` till ${st.until}` : ''}</span>`
    : ` <span style="color:#ff7b72">· closed${st.next ? ` · opens ${st.next}` : ''}</span>`
  return `${esc(spec)}${badge}`
}

function routeButtons(lat: number, lon: number, label: string) {
  const s = host.routeState()
  return `<div class="p-actions">
    <button data-route data-lat="${lat}" data-lon="${lon}" data-label="${esc(label)}"
      class="${s.active ? 'on' : ''}">${s.active && s.eta != null
        ? `${humanEta(s.eta)} · ${humanDistance(s.metres!)}`
        : 'Route here'}</button>
  </div>`
}

export function floorLabel(level: number): string {
  return level === 0 ? 'Ground floor' : `Floor ${level}`
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
      ['Building', p.building ? esc(p.building) : undefined],
      ['Floor', p.level != null ? esc(floorLabel(p.level)) : undefined],
      ['Hours', hoursRow(p.hours)],
      ['Access', wheel ? esc(wheel) : undefined],
      ['Type', p.kind ? esc(p.kind.replace(/_/g, ' ')) : undefined],
      ['Phone', p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : undefined],
      ['Website', p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url.replace(/^https?:\/\//, '').slice(0, 34))}</a>` : undefined],
    ]),
    p.desc ? `<p class="p-note">${esc(p.desc)}</p>` : '',
    p.building ? `<p class="p-note">Indoor places have no pin on the map — the room
      containing this place glows brighter on its floor plan instead.</p>` : '',
    `<p class="src">Hand-surveyed, community-curated — verify before relying on it</p>`,
  ].join('')

  shell(p.name, cat?.label ?? p.cat, body)
}

/* ── buildings & rooms ───────────────────────────────────────────────────── */

export function showBuilding(name: string, cat: string, levels: number) {
  const meta = host.campus.categories[cat]
  const body = [
    kv([
      ['Category', meta ? esc(meta.label) : undefined],
      ['Floors', `${levels}`],
    ]),
    levels > 1
      ? `<p class="p-note">Click the map on this building to open its floor plan.
         Rooms glow where a service is listed; the focused room is brightest.</p>`
      : `<p class="p-note">No indoor floor plan is mapped yet. Trace one in
         <code>data/curated/indoor.geojson</code> and it appears here on the next build.</p>`,
    `<p class="src">Hand-traced, community-curated</p>`,
  ].join('')

  shell(name, meta?.label ?? cat, body)
}

export function showRoom(name: string, building: string, level: number) {
  const body = [
    kv([
      ['Building', esc(building)],
      ['Floor', esc(floorLabel(level))],
    ]),
    `<p class="p-note">No service is listed for this room yet. Add one in
       <code>data/curated/pois.geojson</code> with the room's building and floor,
       and this room will glow on its floor plan.</p>`,
    `<p class="src">Hand-traced, community-curated</p>`,
  ].join('')

  shell(name, `${building} · ${floorLabel(level)}`, body)
}

/* ── about ───────────────────────────────────────────────────────────────── */

export function showAbout(campus: Campus) {
  const total = Object.values(campus.meta.counts).reduce((a, b) => a + b, 0)
  const indoor = campus.pois.filter((p) => p.building).length
  const rooms = campus.rooms?.length ?? 0

  const body = `
    <p class="p-note">Everything here is community-curated. Nothing is scraped and
    nothing is invented — every polygon and pin was traced by hand and lives in
    the <code>data/curated/</code> folder of this project.</p>

    <div class="p-sec">Map & places</div>
    <p class="p-note"><b>${total}</b> places (${indoor} indoors), <b>${rooms}</b> rooms across
    <b>${Object.keys(campus.meta.counts).length}</b> categories. Walking times are computed
    over the traced path network.</p>

    <div class="p-sec">Multi-floor</div>
    <p class="p-note">Click a building with more than one floor to open its floor
    plan. Indoor places have no pins — the room that contains one glows brighter,
    and the rest of the floor stays dimmer.</p>

    ${campus.meta.sample
      ? `<div class="p-sec">Sample data</div>
         <p class="p-note">This build uses <b>sample data</b>. Replace the files in
         <code>data/curated/</code> with your own traces before sharing the map.
         See the README for the geojson.io workflow.</p>`
      : ''}

    <div class="p-sec">Contribute</div>
    <p class="p-note">Something wrong or missing? Trace it at
    <a href="https://geojson.io" target="_blank" rel="noopener">geojson.io</a>,
    drop the file into <code>data/curated/</code>, and rebuild. Full instructions in the
    <a href="${REPO}#readme" target="_blank" rel="noopener">README</a>.</p>

    <p class="src">Built ${esc(campus.meta.built)} · ${esc(campus.meta.attribution)}
    · <a href="${REPO}" target="_blank" rel="noopener">source</a></p>`

  shell('amrita.town', 'About & data sources', body)
}
