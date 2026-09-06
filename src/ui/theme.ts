export type Choice = 'auto' | 'light' | 'dark'
export type Resolved = 'light' | 'dark'

const KEY = 'campusmap.theme'

/**
 * The scheme follows the operating system by default, and the theme button
 * cycles auto → light → dark — exactly the canonical demo's cycle in
 * amrita.town.css. A forced choice is remembered per browser until it is
 * changed back; 'auto' is the fallback when nothing is stored.
 */
const DEFAULT: Choice = 'auto'

let choice: Choice = read()
const listeners = new Set<(t: Resolved) => void>()

function read(): Choice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'auto') return v
    if (v === 'os') return 'auto' // renamed value — migrate old stored choices
  } catch {
    // Private mode or storage disabled — fall through to the default.
  }
  return DEFAULT
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return false
  }
}

export function resolved(): Resolved {
  if (choice !== 'auto') return choice
  return systemPrefersDark() ? 'dark' : 'light'
}

function apply() {
  const r = resolved()
  document.documentElement.setAttribute('data-theme', r)
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', r === 'light' ? '#faf7f0' : '#181818')
  for (const fn of listeners) fn(r)
}

/** Next state in the canonical cycle: auto → light → dark → auto. */
export function cycle(): Choice {
  const next: Record<Choice, Choice> = { auto: 'light', light: 'dark', dark: 'auto' }
  choice = next[choice]
  try { localStorage.setItem(KEY, choice) } catch { /* nothing we can do */ }
  apply()
  return choice
}

/** Which of the three states the button currently sits in. */
export function current(): Choice {
  return choice
}

export function onThemeChange(fn: (t: Resolved) => void) {
  listeners.add(fn)
}

// While the choice is 'auto', a live OS scheme change re-applies immediately.
try {
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (choice === 'auto') apply() })
} catch { /* matchMedia unavailable — static resolution only */ }

// The inline script in index.html sets the attribute before first paint; this
// syncs the meta colour and notifies subscribers once the module loads.
apply()