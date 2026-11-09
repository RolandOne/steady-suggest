// Renders the README mock-ups in this folder to ../<name>.png at 2x, cropped
// to their content. The boards are static HTML from a design canvas, so a
// plain browser draws them; the canvas runtime they name (support.js) is
// stubbed out.
//
// Needs Playwright with Chromium where Node can find it, for example:
//   npm i --no-save playwright && npx playwright install chromium
//   node docs/mockups/shoot.mjs
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..')
const shots = [
  ['Readme-push', 'after-a-reply', 900, 340],
  ['Readme-autopilot', 'autopilot', 900, 400],
  ['Readme-modes', 'modes', 900, 320],
  ['Readme-folded', 'folded', 900, 300],
  ['Readme-thinking', 'thinking', 900, 300],
]

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
for (const [board, name, width, height] of shots) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })
  await page.route('**/support.js', route => route.fulfill({ status: 200, body: '' }))
  await page.goto(`file://${join(here, `${board}.dc.html`)}`)
  // The boards sit their content at the bottom; crop the empty space above
  // the highest element, a dropdown included.
  const top = await page.evaluate(() => {
    const root = document.querySelector('x-dc > div')
    const tops = [...root.querySelectorAll('*')].map(el => el.getBoundingClientRect().top)
    return Math.min(...tops)
  })
  const y = Math.max(0, Math.floor(top) - 24)
  await page.screenshot({ path: join(out, `${name}.png`), clip: { x: 0, y, width, height: height - y } })
  await page.close()
  console.warn(`${name}.png`)
}
await browser.close()
