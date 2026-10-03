import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { assertDisposableDatabase, durableBrowserSnapshot, seedTopicBrowserFixtures, topicBrowserFixtures as fixtures } from './fixtures/topic-directory.mjs'

// First build:core (fixtures load this checkout's packages/core/dist), then run
// --seed-only before starting a disposable DSH profile and --no-seed against
// that profile. Never provide a real user's memory database.
const database = process.env.STRATAGATE_BROWSER_DB
assertDisposableDatabase(database)
if (!process.argv.includes('--no-seed')) {
  const seeded = await seedTopicBrowserFixtures(database)
  if (process.argv.includes('--seed-only')) {
    console.log(JSON.stringify({ result: 'seeded', database: resolve(database), ...seeded }))
    process.exit(0)
  }
}
const launchUrl = process.env.STRATAGATE_BROWSER_URL
if (!launchUrl) throw new Error('Set STRATAGATE_BROWSER_URL for a running disposable DSH Web profile')
const chrome = process.env.STRATAGATE_BROWSER_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const outputDirectory = resolve(process.env.STRATAGATE_BROWSER_SCREENSHOTS || join(tmpdir(), `stratagate-topic-browser-${Date.now()}`))
await mkdir(outputDirectory, { recursive: true })
const baseline = durableBrowserSnapshot(database)
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const requests = []
const errors = []
const screenshots = []
const checks = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, colorScheme: 'light', locale: 'zh-CN' })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname
    if (pathname.startsWith('/api/stratagate/')) requests.push({ method: request.method(), pathname })
  })
  const capture = async (name) => {
    const path = join(outputDirectory, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    screenshots.push(path)
  }
  await page.goto(launchUrl)
  const clickIfShown = async (locator) => {
    try { await locator.waitFor({ state: 'visible', timeout: 5000 }) } catch { return }
    await locator.click()
  }
  await clickIfShown(page.getByRole('button', { name: '继续', exact: true }))
  await clickIfShown(page.getByRole('button', { name: '稍后配置' }))
  await page.getByRole('button', { name: '设置', exact: true }).click()
  // Use the host's real system preference so emulateMedia tests its palette
  // presenter, rather than overwriting StrataGate colors from the test.
  const general = page.getByRole('button', { name: /^(通用|通用设置)$/ })
  if (await general.count() === 1) await general.click()
  const systemTheme = page.getByRole('button', { name: '跟随系统', exact: true })
  if (await systemTheme.count() === 1) await systemTheme.click()
  await page.getByRole('button', { name: 'StrataGate-AgentMemory' }).click()
  const memory = page.getByTestId('stratagate-memory-ui')
  await memory.waitFor()
  assert.deepEqual(await memory.locator('.sg-tabs button').allTextContents(), ['常驻画像', '短期记忆', '长期记忆', '更多'])
  checks.push('four-primary-tabs')
  const selectNamespace = async (namespace) => {
    if (await memory.getByRole('combobox', { name: '当前工作区' }).inputValue() === namespace) return
    const response = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/stratagate/dashboard' && url.searchParams.get('namespace') === namespace && response.ok()
    })
    await memory.getByRole('combobox', { name: '当前工作区' }).selectOption(namespace)
    await (await response).json()
  }
  await selectNamespace(fixtures.normal)
  await memory.getByRole('button', { name: '长期记忆', exact: true }).click()
  const directory = page.getByTestId('stratagate-topic-directory')
  await directory.waitFor()
  for (const name of ['主题目录', '知识图谱', '事件时间线']) assert.equal(await memory.getByRole('button', { name, exact: true }).count(), 1)
  await directory.getByText('默认注入上下文', { exact: true }).waitFor()
  assert.equal(await directory.getByRole('searchbox').count(), 0)
  checks.push('three-long-term-tabs-and-context-label')
  const chapter = (index) => directory.locator(`[data-topic-id="${fixtures.topicIds[index]}"]`)
  assert.equal(await directory.locator('.sg-topic-chapter').count(), 2)
  assert.match(await chapter(0).textContent(), /第一章/)
  assert.match(await chapter(1).textContent(), /第二章/)
  await capture('topic-directory-initial-desktop-light')
  const section = (chapterIndex, sectionIndex) => chapter(chapterIndex).locator(`.sg-topic-section[data-section-index="${sectionIndex}"]`)
  const openSection = async (chapterIndex, sectionIndex) => {
    const target = section(chapterIndex, sectionIndex)
    const toggle = target.locator('button').first()
    if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click()
    await target.getByRole('button', { name: `${chapterIndex + 1}.${sectionIndex}.0 总览`, exact: true }).waitFor()
    return target
  }
  const eventRows = (target) => target.locator('.sg-topic-event[data-topic-event-id]:visible')
  const eight = await openSection(0, 1)
  assert.equal(await eventRows(eight).count(), 8)
  assert.equal(await eight.getByRole('button', { name: /展开全部/ }).count(), 0)
  assert.equal(await eight.getByRole('button', { name: '1.1.0 总览', exact: true }).getAttribute('aria-expanded'), 'true')
  await eight.getByText('八条事件构成这一节的发展脉络。原始事实与来源始终保留。', { exact: true }).waitFor()
  for (let index = 0; index < 8; index++) assert.equal(await eventRows(eight).nth(index).locator('.sg-directory-number').textContent(), `1.1.${index + 1}`)
  checks.push('eight-events-nine-items-overview-open')
  const overviewText = eight.locator('.sg-topic-overview-text')
  const overviewToggle = eight.locator('.sg-topic-overview-toggle')
  await overviewToggle.click()
  await overviewText.waitFor({ state: 'hidden' })
  assert.equal(await eventRows(eight).count(), 8, 'Closing overview should preserve its Event rows')
  await overviewToggle.click()
  await overviewText.waitFor()
  const sectionToggle = eight.locator('.sg-topic-section-toggle')
  await sectionToggle.click()
  await overviewToggle.waitFor({ state: 'hidden' })
  await sectionToggle.click()
  await overviewText.waitFor()
  const chapterToggle = chapter(0).locator('.sg-topic-chapter-toggle')
  await chapterToggle.click()
  await sectionToggle.waitFor({ state: 'hidden' })
  await chapterToggle.click()
  await overviewText.waitFor()
  assert.equal(await sectionToggle.getAttribute('aria-expanded'), 'true')
  assert.equal(await overviewToggle.getAttribute('aria-expanded'), 'true')
  checks.push('chapter-section-and-overview-collapse-reopen-preserves-state')
  const nine = await openSection(0, 2)
  assert.equal(await eventRows(nine).count(), 9)
  assert.equal(await nine.getByRole('button', { name: /展开全部/ }).count(), 0)
  const twelve = await openSection(0, 3)
  assert.equal(await eventRows(twelve).count(), 9)
  await twelve.getByRole('button', { name: '还有 3 条事件 · 展开全部', exact: true }).click()
  assert.equal(await eventRows(twelve).count(), 12)
  assert.equal(await eventRows(twelve).nth(11).locator('.sg-directory-number').textContent(), '1.3.12')
  await twelve.getByRole('button', { name: '收起多余事件', exact: true }).click()
  assert.equal(await eventRows(twelve).count(), 9)
  const one = await openSection(0, 4)
  assert.equal(await eventRows(one).count(), 1)
  assert.equal(await one.getByRole('button', { name: /展开全部/ }).count(), 0)
  checks.push('one-nine-twelve-event-boundaries-and-collapse')

  const firstEvent = eventRows(eight).first()
  const clickedEventId = await firstEvent.getAttribute('data-topic-event-id')
  const sourceRead = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/api/stratagate/sources' && url.searchParams.get('eventId') === clickedEventId && response.ok()
  })
  await firstEvent.click()
  await sourceRead
  await memory.locator('.sg-event-page-header').waitFor()
  await memory.getByRole('heading', { name: '记忆内容', exact: true }).waitFor()
  await memory.locator('.sg-citation-disclosure').filter({ has: page.locator('summary', { hasText: '来源与证据' }) }).locator('summary').click()
  await memory.locator('.sg-citation-message').filter({ hasText: fixtures.raw }).waitFor()
  await memory.locator('.sg-citation-disclosure').filter({ has: page.locator('summary', { hasText: '技术信息' }) }).locator('summary').click()
  await memory.getByText(clickedEventId, { exact: true }).waitFor()
  await memory.getByText('来源 Block', { exact: true }).waitFor()
  await memory.locator('.sg-back').click()
  await directory.waitFor()
  assert.equal(await eventRows(section(0, 1)).count(), 8, 'Event back navigation lost expanded sections')
  checks.push('existing-event-detail-raw-and-block-provenance')

  const fallback = directory.locator('.sg-topic-pending')
  await fallback.getByText('待整理', { exact: true }).waitFor()
  assert.equal(await fallback.locator('.sg-topic-chapter').count(), 0)
  await fallback.locator('[data-topic-event-id]').first().click()
  await memory.locator('.sg-event-page-header').waitFor()
  await memory.locator('.sg-back').click()
  await directory.waitFor()
  checks.push('fallback-remains-direct-event-entry')

  // Delay one real GET without replacing its response. Cached chapters must
  // not appear under the newly selected namespace while its dashboard loads.
  let releaseDashboard
  let dashboardIntercepted
  const delayed = new Promise((resolve) => { releaseDashboard = resolve })
  const intercepted = new Promise((resolve) => { dashboardIntercepted = resolve })
  let delayNext = true
  const dashboardPattern = /\/api\/stratagate\/dashboard(?:\?|$)/
  const delayDashboard = async (route) => {
    if (delayNext && new URL(route.request().url()).searchParams.get('namespace') === fixtures.empty) {
      delayNext = false
      dashboardIntercepted()
      await delayed
    }
    await route.continue()
  }
  await page.route(dashboardPattern, delayDashboard)
  const changingNamespace = selectNamespace(fixtures.empty)
  try {
    await intercepted
    await page.waitForFunction(() => [...document.querySelectorAll('.sg-topic-chapter')]
      .every((element) => !element.getClientRects().length || getComputedStyle(element).visibility === 'hidden'))
    assert.equal(await memory.getByRole('combobox', { name: '当前工作区' }).inputValue(), fixtures.empty)
  } finally {
    releaseDashboard()
    await changingNamespace
    await page.unroute(dashboardPattern, delayDashboard)
  }
  await directory.waitFor()
  assert.equal(await directory.locator('.sg-topic-chapter').count(), 0)
  checks.push('real-dashboard-delay-never-shows-previous-namespace-topics')

  for (const variant of ['pending', 'running', 'failed', 'normal', 'empty']) {
    await selectNamespace(fixtures[variant])
    await directory.waitFor()
    if (variant === 'pending' || variant === 'running') {
      await directory.locator('.sg-topic-bootstrap').getByText(/正在整理历史记忆/).waitFor()
      assert.match(await directory.locator('.sg-topic-bootstrap').textContent(), /24\s*\/\s*25/)
    } else if (variant === 'failed') {
      await directory.locator('.sg-topic-bootstrap').getByText(/1 条历史记忆暂未完成整理/).waitFor()
      await directory.getByRole('button', { name: '查看详情', exact: true }).click()
      await directory.locator('.sg-topic-failure-technical summary').click()
      await directory.getByText(/timeout/).waitFor()
    } else {
      assert.equal(await directory.locator('.sg-topic-bootstrap').count(), 0)
      if (variant === 'empty') assert.equal(await directory.locator('.sg-topic-chapter').count(), 0)
    }
  }
  checks.push('bootstrap-pending-running-completed-failed-empty')

  await selectNamespace(fixtures.normal)
  for (let index = 1; index <= 4; index++) await openSection(0, index)
  for (let index = 1; index <= 8; index++) await openSection(1, index)
  await directory.evaluate(async (element) => {
    // Test stable scroll restoration after the intentionally animated section
    // layout has settled; ignore unrelated infinite processing animations.
    await Promise.allSettled(element.getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
  const deepEvent = eventRows(section(1, 8)).last()
  await deepEvent.scrollIntoViewIfNeeded()
  await deepEvent.evaluate((element) => {
    const ancestors = []
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight) ancestors.push({ node, top: node.scrollTop, left: node.scrollLeft })
    }
    window.__topicBrowserScrollSnapshot = { element, ancestors, top: window.scrollY, left: window.scrollX }
  })
  await deepEvent.click()
  await memory.locator('.sg-event-page-header').waitFor()
  await memory.locator('.sg-back').click()
  await directory.waitFor()
  await page.waitForFunction(() => {
    const saved = window.__topicBrowserScrollSnapshot
    return document.activeElement === saved.element && Math.abs(window.scrollY - saved.top) <= 5
      && saved.ancestors.every(({ node, top, left }) => Math.abs(node.scrollTop - top) <= 5 && Math.abs(node.scrollLeft - left) <= 5)
  })
  assert.equal(await section(1, 8).locator('.sg-topic-section-toggle').getAttribute('aria-expanded'), 'true')
  checks.push('deep-event-back-preserves-specific-trigger-focus-and-scroll')
  await chapter(0).scrollIntoViewIfNeeded()
  const themeColors = async () => memory.evaluate((element) => {
    const style = getComputedStyle(element)
    return { background: style.backgroundColor, text: style.color, hostDark: document.body.getAttribute('data-ds-dark-theme') }
  })
  const lightTheme = await themeColors()
  await capture('topic-directory-desktop-light')
  await chapter(1).scrollIntoViewIfNeeded()
  await capture('topic-directory-desktop-many-sections')
  assert.equal(await chapter(1).locator('.sg-topic-section').count(), 8)
  await page.setViewportSize({ width: 420, height: 900 })
  await chapter(0).scrollIntoViewIfNeeded()
  const checkHorizontalFit = async () => {
    const fit = await directory.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }))
    if (fit.scroll > fit.client + 2) {
      const overflow = await directory.evaluate((element) => {
        const boundary = element.getBoundingClientRect()
        return [...element.querySelectorAll('*')].flatMap((node) => {
          const rect = node.getBoundingClientRect()
          return rect.right > boundary.right + 2 && rect.height > 0 ? [{ className: node.className, tag: node.tagName, left: rect.left - boundary.left, right: rect.right - boundary.right, width: rect.width, scroll: node.scrollWidth, client: node.clientWidth }] : []
        }).slice(0, 16)
      })
      console.error(JSON.stringify({ horizontalFit: fit, overflow }))
    }
    assert.ok(fit.scroll <= fit.client + 2, `Directory overflows horizontally: ${JSON.stringify(fit)}`)
  }
  await checkHorizontalFit()
  await capture('topic-directory-narrow-420-host-layout')
  await page.setViewportSize({ width: 640, height: 900 })
  await chapter(0).scrollIntoViewIfNeeded()
  await checkHorizontalFit()
  await capture('topic-directory-narrow-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForFunction((light) => {
    const style = getComputedStyle(document.querySelector('[data-testid="stratagate-memory-ui"]'))
    return style.color !== light.text && style.backgroundColor !== light.background
  }, lightTheme)
  const darkTheme = await themeColors()
  assert.notDeepEqual(darkTheme, lightTheme, 'Host did not switch to a real dark palette')
  await chapter(1).scrollIntoViewIfNeeded()
  await checkHorizontalFit()
  await capture('topic-directory-narrow-dark')
  await page.setViewportSize({ width: 1280, height: 1000 })
  await chapter(0).scrollIntoViewIfNeeded()
  await capture('topic-directory-desktop-dark')
  checks.push('desktop-narrow-light-dark-long-title-and-multi-section-scroll')

  // A primary-tab switch from detail must not restore the previous directory's
  // deep scroll into an unrelated page. Only the explicit back action restores.
  await deepEvent.scrollIntoViewIfNeeded()
  await deepEvent.click()
  await memory.locator('.sg-event-page-header').waitFor()
  await memory.getByRole('button', { name: '短期记忆', exact: true }).click()
  await memory.getByRole('heading', { name: '块衰减总览', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.__topicBrowserScrollSnapshot.ancestors
    .filter(({ node }) => node.isConnected).every(({ node }) => node.scrollTop <= 5)), true)
  checks.push('direct-primary-tab-from-detail-does-not-restore-directory-scroll')
  await memory.getByRole('button', { name: '长期记忆', exact: true }).click()

  await memory.getByRole('button', { name: '知识图谱', exact: true }).click()
  await memory.locator('.sg-long-explorer').waitFor()
  const bodyOverflow = await page.evaluate(() => document.body.style.overflow)
  await memory.getByRole('button', { name: '⛶ 全屏查看图谱', exact: true }).click()
  await memory.locator('.sg-long-explorer.fullscreen').waitFor()
  await memory.getByRole('button', { name: '主题目录', exact: true }).click()
  await directory.waitFor()
  await page.waitForFunction((previous) => document.body.style.overflow === previous, bodyOverflow)
  assert.equal(await memory.locator('.sg-long-explorer.fullscreen').count(), 0)
  checks.push('graph-fullscreen-to-directory-releases-body-scroll-lock')
  await memory.getByRole('button', { name: '事件时间线', exact: true }).click()
  await memory.locator('.sg-timeline-card').first().waitFor()
  await memory.getByRole('button', { name: '短期记忆', exact: true }).click()
  await memory.getByRole('heading', { name: '块衰减总览', exact: true }).waitFor()
  await memory.locator('.sg-block-toggle').first().waitFor()
  await memory.getByRole('button', { name: '常驻画像', exact: true }).click()
  await memory.getByRole('heading', { name: '常驻用户画像', exact: true }).waitFor()
  checks.push('graph-timeline-short-term-profile-smoke')

  assert.ok(requests.length > 0)
  assert.ok(requests.some(({ pathname }) => pathname === '/api/stratagate/sources'))
  assert.deepEqual(requests.filter(({ method }) => method !== 'GET'), [], 'Browsing must not perform memory mutations')
  const readonlyRoutes = new Set(['dashboard', 'overview', 'profile', 'sources', 'memories', 'topics', 'settings'].map((name) => '/api/stratagate/' + name))
  assert.deepEqual(requests.filter(({ pathname }) => !readonlyRoutes.has(pathname)), [], 'Browsing invoked a retrieval tool, adoption or model endpoint')
  assert.deepEqual(durableBrowserSnapshot(database), baseline, 'Browsing changed memory, model receipts, weights, topic state or integration metadata')
  assert.deepEqual(errors, [], 'Browser page raised an uncaught JavaScript exception')
  checks.push('get-only-and-all-durable-tables-unchanged-no-model-or-adoption-records')
  const result = { result: 'passed', checks, screenshots, themes: { light: lightTheme, dark: darkTheme }, requests, errors, outputDirectory }
  await writeFile(join(outputDirectory, 'topic-directory-browser-review.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
} catch (error) {
  const page = browser.contexts()[0]?.pages()[0]
  if (page) {
    await page.screenshot({ path: join(outputDirectory, 'topic-directory-failure.png'), fullPage: true }).catch(() => {})
    const scroll = await page.evaluate(() => {
      const saved = window.__topicBrowserScrollSnapshot
      if (!saved) return null
      return {
        focused: document.activeElement === saved.element,
        actualEvent: document.activeElement?.getAttribute('data-topic-event-id'),
        expectedEvent: saved.element?.getAttribute('data-topic-event-id'),
        window: { actual: window.scrollY, expected: saved.top },
        ancestors: saved.ancestors.map(({ node, top, left }) => ({ className: node.className, actual: node.scrollTop, expected: top, actualLeft: node.scrollLeft, expectedLeft: left, connected: node.isConnected })),
      }
    }).catch(() => null)
    await writeFile(join(outputDirectory, 'topic-directory-failure.json'), JSON.stringify({ checks, scroll, errors }, null, 2) + '\n').catch(() => {})
    console.error(JSON.stringify({ completedChecks: checks, scroll }))
  }
  throw error
} finally {
  await browser.close()
}
