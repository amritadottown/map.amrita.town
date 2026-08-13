// Loads the built site in a real headless Chrome, on a throwaway profile, and
// fails on any console error, page error or failed request. The unit tests
// cannot catch "the map never appeared"; this can. It also proves the
// multi-floor flow: open a room from search, click a building footprint, and
// switch floors.
//
//   bun run verify              # expects a server on :5180
//   bun run verify -- --url http://localhost:5199
//   bun run verify -- --shot    # also write screenshots to .verify/
//
// If no Chrome binary is found the script says so and exits 0 — the smoke
// tests remain the CI gate.

import puppeteer from 'puppeteer-core'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Data-driven: the multi-floor flow runs only when the curated data actually
// has floor plans. Everything else adapts to however many POIs exist.
const campus = JSON.parse(await readFile(join(ROOT, 'public/data/campus.json'), 'utf8'))
const geoData = JSON.parse(await readFile(join(ROOT, 'public/data/geo.json'), 'utf8'))
const planEntries = Object.entries(geoData.floors ?? {})
// A building can only be referenced by indoor.geojson when it has a name, so
// every floor plan belongs to a named building — the click test depends on it.
const plan = planEntries.find(([, p]) => p.levels.length > 1) ?? planEntries[0]
const planName = plan?.[0]
const planLevels = plan?.[1]?.levels ?? []
const room = planName
  ? campus.rooms.find((r) => r.building === planName && r.level !== (planLevels[0] ?? 0)) ??
    campus.rooms.find((r) => r.building === planName)
  : undefined
const expectedChips = Object.keys(campus.meta.counts ?? {}).length
const argOf = (k, d) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > -1 ? process.argv[i + 1] : d
}
const URL_ = argOf('url', 'http://localhost:5180/')
const SHOTS = process.argv.includes('--shot')

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p))

if (!CHROME) {
  console.error('No Chrome found — skipping browser verification.')
  process.exit(0)
}

let failures = 0
const ok = (cond, label, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const PROFILE = join(ROOT, 'node_modules/.cache/verify-profile')
await rm(PROFILE, { recursive: true, force: true })
if (SHOTS) await mkdir(join(ROOT, '.verify'), { recursive: true })

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  userDataDir: PROFILE,
  args: ['--no-sandbox', '--disable-gpu', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})

async function check(name, width, height, theme) {
  console.log(`\n${name} (${width}x${height}${theme ? `, ${theme}` : ''})`)
  const page = await browser.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 1 })
  if (theme) {
    await page.evaluateOnNewDocument((t) => {
      try { localStorage.setItem('campusmap.theme', t) } catch {}
    }, theme)
  }

  const errors = []
  const failed = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText}`))
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`HTTP ${r.status()} ${r.url()}`)
  })

  await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 30_000 })

  const booted = await page.waitForFunction(
    () => document.getElementById('boot')?.classList.contains('gone'),
    { timeout: 20_000 },
  ).then(() => true).catch(() => false)

  const bootText = await page.$eval('#boot', (el) => el.textContent?.trim() ?? '')
  ok(booted, 'map finished loading', booted ? '' : `boot still says: "${bootText}"`)
  ok(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '))
  ok(failed.length === 0, 'no failed requests', failed.slice(0, 3).join(' | '))

  const painted = await page.evaluate(() => {
    const c = document.querySelector('#map canvas')
    return c ? c.width > 0 && c.height > 0 : false
  })
  ok(painted, 'map canvas has dimensions')

  const css = await page.evaluate(() => {
    const sheets = [...document.styleSheets].filter((s) => {
      try { return s.cssRules.length > 0 } catch { return false }
    }).length
    const bg = getComputedStyle(document.body).backgroundColor
    const tok = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    return { sheets, bg, tok }
  })
  ok(css.sheets > 0 && css.tok !== '', 'stylesheet applied',
     css.tok === '' ? 'design tokens missing — CSS downloaded but not applied' : `--bg ${css.tok}`)
  ok(css.bg !== 'rgba(0, 0, 0, 0)', 'body has a painted background', css.bg)

  const dots = await page.evaluate(() =>
    document.querySelectorAll('#layer-chips .chip').length)
  ok(dots === expectedChips, `layer chips rendered (${dots}, expected ${expectedChips})`)

  const sheetMode = await page.evaluate(() =>
    getComputedStyle(document.getElementById('layers-btn')).display !== 'none')

  if (sheetMode) {
    await page.click('#layers-btn')
    await page.waitForFunction(() => {
      const el = document.getElementById('layers')
      if (!el.classList.contains('open')) return false
      return el.getBoundingClientRect().bottom <= document.documentElement.clientHeight + 1
    }, { timeout: 3000 })
  }

  if (dots > 0) {
    const legend = await page.evaluate(() => {
      const box = document.getElementById('layer-chips')
      const chips = [...box.querySelectorAll('.chip')]
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      return {
        hScroll: box.scrollWidth > box.clientWidth + 1,
        offscreen: chips.filter((c) => {
          const r = c.getBoundingClientRect()
          return r.right > vw + 1 || r.left < -1
        }).length,
        belowFold: chips.filter((c) => c.getBoundingClientRect().top > vh).length,
        cols: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().left))).size,
        minTap: Math.round(Math.min(...chips.map((c) => c.getBoundingClientRect().height))),
      }
    })
    ok(!legend.hScroll, `legend does not scroll sideways${sheetMode ? ' (sheet)' : ' (dock)'}`)
    ok(legend.offscreen === 0, `all ${dots} chips within the viewport (${legend.cols} columns)`,
       legend.offscreen ? `${legend.offscreen} cut off` : '')
    if (sheetMode) {
      ok(legend.minTap >= 34, `chips are tappable (${legend.minTap}px tall)`)
      ok(legend.belowFold === 0, 'no chip starts below the fold',
         legend.belowFold ? `${legend.belowFold} need scrolling` : '')
      await page.click('.layers-close')
      await page.waitForFunction(() =>
        !document.getElementById('layers').classList.contains('open'), { timeout: 2000 })
      ok(true, 'sheet closes')
    }
  } else {
    ok(true, 'no layer chips yet — trace data/curated/pois.geojson', '0 chips')
    if (sheetMode) {
      await page.click('.layers-close')
      await page.waitForFunction(() =>
        !document.getElementById('layers').classList.contains('open'), { timeout: 2000 })
    }
  }

  ok(await page.$('#foot a') !== null, 'source link present in footer')

  /* ── multi-floor: search a room ─────────────────────────────────────── */

  if (!planName || !room) {
    ok(true, 'no floor plans to verify yet — trace data/curated/indoor.geojson',
       planName ? `plan ${planName} has no rooms` : 'geo.floors empty')
  } else {
    await page.keyboard.down('Meta'); await page.keyboard.press('KeyK'); await page.keyboard.up('Meta')
    const paletteOpen = await page.waitForFunction(
      () => document.getElementById('palette') && !document.getElementById('palette').hidden,
      { timeout: 4000 },
    ).then(() => true).catch(() => false)
    ok(paletteOpen, 'palette opens on ⌘K')

    if (paletteOpen) {
      await page.type('#palette-input', room.name, { delay: 12 })
      await page.waitForFunction(() => document.querySelectorAll('#palette-results .row').length > 0,
        { timeout: 4000 }).catch(() => {})
      const rows = await page.$$eval('#palette-results .row .row-title', (r) => r.map((x) => x.textContent))
      ok(rows.length > 0, `"${room.name}" returns results (${rows.length})`, rows[0] ?? '')

      await page.keyboard.press('Enter')

      const floorBar = await page.waitForFunction(
        () => document.getElementById('floor-bar') && !document.getElementById('floor-bar').hidden,
        { timeout: 4000 },
      ).then(() => true).catch(() => false)
      ok(floorBar, 'searching a room opens the floor bar')

      if (floorBar) {
        const chips = await page.$$eval('#floor-bar .fb-chips button', (b) => b.map((x) => x.dataset.level))
        ok(chips.length >= 2, `floor chips rendered (${chips.join(', ')})`, `levels: ${chips.join(', ')}`)

        // The room hit must land on the right floor.
        const on = await page.evaluate(() =>
          document.querySelector('#floor-bar .fb-chips button.on')?.dataset.level)
        ok(on === String(room.level), `"${room.name}" opened floor ${room.level}`, `active chip: ${on}`)

        // Close and reopen via a real map click on the building footprint.
        await page.click('#floor-bar [data-close]')
        const closed = await page.evaluate(() => document.getElementById('floor-bar').hidden)
        ok(closed, 'floor bar closes')

        const clicked = await page.evaluate((name) => {
          const m = window.__map
          if (!m) return 'no map'
          const f = m.queryRenderedFeatures({ layers: ['building'] })
            .find((x) => x.properties?.name === name)
          if (!f) return 'building not found'
          const ring = f.geometry.coordinates[0]
          let w = 180, s = 90, e = -180, n = -90
          for (const [x, y] of ring) {
            w = Math.min(w, x); e = Math.max(e, x)
            s = Math.min(s, y); n = Math.max(n, y)
          }
          const pt = m.project([(w + e) / 2, (s + n) / 2])
          return { x: pt.x, y: pt.y }
        }, planName)
        ok(clicked !== 'no map' && clicked !== 'building not found', `${planName} footprint clickable`,
           typeof clicked === 'string' ? clicked : '')
        if (typeof clicked !== 'string') {
          await page.mouse.click(clicked.x, clicked.y)
          const reopened = await page.waitForFunction(
            () => document.getElementById('floor-bar') && !document.getElementById('floor-bar').hidden,
            { timeout: 4000 },
          ).then(() => true).catch(() => false)
          ok(reopened, 'clicking the building opens the floor bar')

          if (reopened) {
            const target = String(planLevels[planLevels.length - 1])
            await page.evaluate((lvl) => {
              const btn = document.querySelector(`#floor-bar .fb-chips button[data-level="${lvl}"]`)
              if (btn) btn.click()
            }, target)
            await page.waitForFunction(() => {
              const m = window.__map
              if (!m) return false
              return m.queryRenderedFeatures({ layers: ['floor-label'] }).length > 0
            }, { timeout: 5000 }).then(() => {}).catch(() => {})
            const labels = await page.evaluate(() =>
              window.__map?.queryRenderedFeatures({ layers: ['floor-label'] }).length ?? 0)
            ok(labels > 0, `floor ${target} room labels rendering (${labels} visible)`)
          }
        }
      }
    }
  }

  if (SHOTS) {
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(ROOT, `.verify/${name}.png`) })
  }

  ok(errors.length === 0, 'still no console errors after interaction', errors.slice(0, 3).join(' | '))
  await page.close()
}

await check('desktop-dark', 1440, 900, 'dark')
await check('desktop-light', 1440, 900, 'light')
await check('mobile-dark', 402, 874, 'dark')

await browser.close()
await rm(PROFILE, { recursive: true, force: true })

console.log(failures ? `\n${failures} failure(s)\n` : '\nbrowser verification passed\n')
process.exit(failures ? 1 : 0)
