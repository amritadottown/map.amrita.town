import type { Campus, Poi } from '../types'
import { openNow } from './hours'

/* ── documents ───────────────────────────────────────────────────────────── */

export type Kind = 'place' | 'room' | 'layer' | 'action' | 'hint'

export interface Doc {
  kind: Kind
  id: string
  title: string
  sub: string
  /** Everything matchable, lowercase, space-joined. Built once. */
  hay: string
  /** Tokens given prefix-match priority — the name words, codes, aliases. */
  keys: string[]
  cat?: string
  lat?: number
  lon?: number
  poi?: Poi
  /** Room hits carry the building + floor to open. */
  building?: string
  level?: number
  roomId?: string
  hours?: string
  /** Nudges ties: higher wins. */
  boost: number
  run?: () => void
}

export interface Hit extends Doc {
  score: number
  /** Character indices in `title` that matched, for highlighting. */
  marks: number[]
}

const lower = (s: string) => s.toLowerCase()
const words = (s: string) => lower(s).split(/[^a-z0-9]+/).filter(Boolean)

/* ── scoring ─────────────────────────────────────────────────────────────── */

/**
 * Subsequence match with contiguity and word-boundary bonuses, in the spirit of
 * fzf but far simpler. Returns -1 for no match. Left-anchored matches and
 * matches that start a word score much higher, which is what makes "203",
 * "gate", "canteen" and "room g-05" all land where you expect.
 */
function fuzzy(needle: string, hay: string): { score: number; at: number[] } | null {
  if (!needle) return { score: 0, at: [] }
  const n = needle.length, h = hay.length
  if (n > h) return null

  const at: number[] = []
  let score = 0
  let hi = 0
  let streak = 0

  for (let ni = 0; ni < n; ni++) {
    const c = needle[ni]!
    let found = -1
    while (hi < h) {
      if (hay[hi] === c) { found = hi; break }
      hi++
    }
    if (found === -1) return null

    let bonus = 1
    const prev = found > 0 ? hay[found - 1]! : ' '
    if (found === 0) bonus += 8
    else if (prev === ' ' || prev === '-' || prev === '/') bonus += 6
    else if (prev >= '0' && prev <= '9' && !(c >= '0' && c <= '9')) bonus += 2

    streak = at.length && at[at.length - 1] === found - 1 ? streak + 1 : 0
    bonus += Math.min(streak * 3, 12)

    score += bonus
    at.push(found)
    hi = found + 1
  }

  // Prefer shorter haystacks and matches that start early.
  score -= Math.min(at[0]! * 0.4, 12)
  score -= Math.min(h * 0.02, 6)
  return { score, at }
}

function scoreDoc(doc: Doc, q: string, qWords: string[]): Hit | null {
  // 1. Exact / prefix on a key token — the strongest signal by far.
  let best = -1
  let marks: number[] = []

  for (const k of doc.keys) {
    if (k === q) { best = Math.max(best, 1000); break }
    if (k.startsWith(q)) best = Math.max(best, 700 - (k.length - q.length))
  }

  // 2. Title fuzzy.
  const t = fuzzy(q, lower(doc.title))
  if (t) {
    const s = 300 + t.score
    if (s > best) { best = s; marks = t.at }
  }

  // 3. Every query word must appear somewhere. Handles "central canteen",
  //    "main gate", "room 203" — order-independent.
  if (best < 0 && qWords.length > 1) {
    let all = true
    let sum = 0
    for (const w of qWords) {
      const i = doc.hay.indexOf(w)
      if (i === -1) { all = false; break }
      sum += 40 - Math.min(i * 0.05, 20)
    }
    if (all) best = sum
  }

  // 4. Last resort: substring anywhere in the haystack.
  if (best < 0) {
    const i = doc.hay.indexOf(q)
    if (i === -1) return null
    best = 30 - Math.min(i * 0.05, 20)
  }

  return { ...doc, score: best + doc.boost, marks }
}

/* ── index ───────────────────────────────────────────────────────────────── */

export class SearchIndex {
  readonly docs: Doc[] = []

  constructor(campus: Campus, hooks: {
    onLayer: (cat: string) => void
    onAction: (id: string) => void
  }) {
    for (const p of campus.pois) {
      const alias = ALIASES[p.cat] ?? []
      const keys = [
        lower(p.name), ...words(p.name), ...alias,
        ...(p.aliases ?? []).flatMap((x) => [lower(x), ...words(x)]),
      ]
      if (p.building) keys.push(...words(p.building))
      const floorLabel = p.level == null ? '' : floorName(p.level)

      this.docs.push({
        kind: 'place',
        id: p.id,
        title: p.name,
        sub: [
          campus.categories[p.cat]?.label,
          p.building ? `${p.building} · ${floorLabel}` : '',
        ].filter(Boolean).join(' · '),
        hay: lower([p.name, ...(p.aliases ?? []), p.cat,
                    campus.categories[p.cat]?.label, p.kind, p.desc, p.building,
                    p.building && floorLabel, ...alias].filter(Boolean).join(' ')),
        keys,
        cat: p.cat,
        lat: p.lat, lon: p.lon,
        poi: p,
        building: p.building,
        level: p.level,
        roomId: p.room,
        hours: p.hours,
        boost: (campus.categories[p.cat]?.pin ? 12 : 0) + (p.building ? 3 : 0),
      })
    }

    // Every room on every floor plan is searchable, with or without a POI.
    for (const r of campus.rooms ?? []) {
      const label = floorName(r.level)
      this.docs.push({
        kind: 'room',
        id: `room:${r.id}`,
        title: r.name,
        sub: `${r.building} · ${label}`,
        hay: lower([r.name, r.building, label, 'room floor'].filter(Boolean).join(' ')),
        keys: [...words(r.name), ...words(r.building), 'room'],
        building: r.building,
        level: r.level,
        roomId: r.id,
        cat: r.poiId ? campus.pois.find((p) => p.id === r.poiId)?.cat : undefined,
        lat: r.poiId ? campus.pois.find((p) => p.id === r.poiId)?.lat : undefined,
        lon: r.poiId ? campus.pois.find((p) => p.id === r.poiId)?.lon : undefined,
        boost: (r.poiId ? 8 : 4) + (r.name === 'Corridor' || r.name === 'Stairs' || r.name === 'Lift' ? -8 : 0),
      })
    }

    for (const [cat, meta] of Object.entries(campus.categories)) {
      const n = campus.meta.counts[cat] ?? 0
      if (!n) continue
      this.docs.push({
        kind: 'layer',
        id: `layer:${cat}`,
        title: meta.label,
        sub: `Show all ${n} on the map`,
        hay: lower([cat, meta.label, ...(ALIASES[cat] ?? [])].join(' ')),
        keys: [cat, ...words(meta.label), ...(ALIASES[cat] ?? [])],
        cat,
        boost: 8,
        run: () => hooks.onLayer(cat),
      })
    }

    for (const a of ACTIONS) {
      this.docs.push({
        kind: 'action',
        id: `do:${a.id}`,
        title: a.title,
        sub: a.sub,
        hay: lower([a.title, a.sub, a.words].join(' ')),
        keys: words(a.title + ' ' + a.words),
        boost: 2,
        run: () => hooks.onAction(a.id),
      })
    }
  }

  search(raw: string, limit = 40): Hit[] {
    const q = lower(raw.trim())
    if (!q) return []
    const qWords = words(q)

    const out: Hit[] = []
    for (const doc of this.docs) {
      const hit = scoreDoc(doc, q, qWords)
      if (hit) out.push(hit)
    }
    out.sort((a, b) => b.score - a.score || a.title.length - b.title.length)

    // "open now" nudge: among close scores, prefer somewhere you can actually go.
    const top = out.slice(0, limit)
    for (const h of top) {
      const st = openNow(h.hours)
      if (st?.open) h.score += 3
    }
    top.sort((a, b) => b.score - a.score)
    return top
  }

  /** Suggestions for the empty state — real things that exist in this data. */
  examples(): string[] {
    const out = ['main gate', 'canteen', 'room 203', 'water', 'atm', 'lecture hall']
    return out
  }
}

function floorName(level: number): string {
  return level === 0 ? 'Ground floor' : `Floor ${level}`
}

/* ── vocabulary ──────────────────────────────────────────────────────────── */

/** Words a student would actually type for each category. */
const ALIASES: Record<string, string[]> = {
  lecture: ['lecture', 'class', 'hall', 'room', 'tutorial', 'classroom'],
  academic: ['dept', 'department', 'lab', 'building', 'office', 'block'],
  admin: ['office', 'admin', 'security', 'help', 'reception', 'lost', 'found'],
  hostel: ['hostel', 'hall', 'room', 'wing', 'block'],
  mess: ['mess', 'food', 'khana', 'meal', 'breakfast', 'lunch', 'dinner'],
  canteen: ['canteen', 'cafe', 'coffee', 'food', 'eat', 'restaurant', 'snack', 'chai', 'tea', 'juice'],
  shop: ['shop', 'store', 'buy', 'grocery', 'stationery'],
  library: ['library', 'books', 'read', 'study'],
  health: ['health', 'doctor', 'clinic', 'medical', 'pharmacy', 'medicine', 'emergency'],
  sports: ['sports', 'gym', 'ground', 'court', 'field', 'play'],
  transport: ['bus', 'parking', 'auto', 'taxi', 'gate', 'entrance'],
  water: ['water', 'cooler', 'drinking', 'ro', 'bottle', 'pani'],
  atm: ['atm', 'cash', 'money', 'bank', 'withdraw'],
  worship: ['temple', 'church', 'prayer', 'worship'],
  toilet: ['toilet', 'washroom', 'restroom', 'bathroom', 'loo'],
  parking: ['parking', 'park', 'vehicle', 'bike', 'cycle'],
  green: ['ground', 'lawn', 'open', 'green', 'garden'],
}

const ACTIONS = [
  { id: 'locate', title: 'Find my location', sub: 'Centre the map on you', words: 'gps where am i me here' },
  { id: 'layers-all', title: 'Show every layer', sub: 'Turn all categories on', words: 'all layers everything show' },
  { id: 'layers-none', title: 'Hide every layer', sub: 'Clear the map', words: 'none clear hide reset layers' },
  { id: 'clear-route', title: 'Clear route', sub: 'Remove the drawn path', words: 'route clear cancel remove path' },
  { id: 'about', title: 'About & data sources', sub: 'Where every number comes from', words: 'about data source credit help' },
]
