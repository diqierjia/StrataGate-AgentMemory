import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { SqliteStorage } from '@diqier/stratagate/sqlite'

const launchUrl = process.env.STRATAGATE_BROWSER_URL
const database = process.env.STRATAGATE_BROWSER_DB
const chrome = process.env.STRATAGATE_BROWSER_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const outputDirectory = resolve(process.env.STRATAGATE_BROWSER_SCREENSHOTS || 'docs/assets')
if (!launchUrl || !database) throw new Error('Set STRATAGATE_BROWSER_URL and STRATAGATE_BROWSER_DB for a running disposable DSH Web profile')
if (!resolve(database).toLowerCase().startsWith((resolve(tmpdir()) + sep).toLowerCase())) {
  throw new Error('Browser regression may modify only a disposable database under the system temp directory')
}

const browser = await chromium.launch({ executablePath: chrome, headless: true })
const store = new SqliteStorage({ filename: database })
try {
  store.updateProfileField('reasoningLanguage', '', 'settings')
  store.updateProfileField('homeCity', '', 'settings')
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, colorScheme: 'dark', locale: 'zh-CN' })
  const page = await context.newPage()
  let profileReads = 0
  page.on('request', (request) => { if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/stratagate/profile') profileReads++ })
  await page.goto(launchUrl)
  const clickIfShown = async (locator) => {
    try { await locator.waitFor({ state: 'visible', timeout: 10000 }) } catch { return }
    await locator.click()
  }
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  await clickIfShown(continueButton)
  const laterButton = page.getByRole('button', { name: '稍后配置' })
  await clickIfShown(laterButton)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'StrataGate-AgentMemory' }).click()
  const tabs = page.locator('.sg-tabs button')
  assert.deepEqual(await tabs.allTextContents(), ['总览', '常驻画像', '会话记忆', '短期记忆', '长期记忆', '更多'])
  await page.getByRole('button', { name: '常驻画像', exact: true }).click()
  await page.getByRole('heading', { name: '常驻用户画像' }).waitFor()
  await page.locator('.sg-profile-row').first().waitFor()
  assert.equal(await page.locator('.sg-profile-row').count(), 11)
  assert.equal(await page.locator('.sg-profile-group').count(), 5)
  assert.equal(await page.locator('.sg-profile-editor textarea').count(), 0)
  const reasoningRow = page.locator('.sg-profile-row').filter({ hasText: '思考过程用什么语言' })
  assert.equal(await reasoningRow.locator('.sg-profile-value').textContent(), '未设置')

  const suffix = Date.now().toString(36)
  const agentLanguage = `验收中文-${suffix}`
  const maintenanceValue = `旧偏好 A ${suffix}`
  const agentValue = `后台新偏好 B ${suffix}`
  const draft = `本地草稿 C ${suffix}`
  const saved = `保存后的偏好 C ${suffix}`
  store.updateProfileField('preferredLanguage', agentLanguage, 'agent_tool')
  const languageRow = page.locator('.sg-profile-row').filter({ hasText: '回答用什么语言' })
  await languageRow.getByText(agentLanguage).waitFor({ timeout: 12000 })
  store.updateProfileField('responsePreferences', maintenanceValue, 'maintenance')
  const responseRow = page.locator('.sg-profile-row').filter({ hasText: '回复方式' })
  await responseRow.getByText(maintenanceValue).waitFor({ timeout: 12000 })
  await responseRow.getByRole('button', { name: '编辑' }).click()
  await responseRow.getByRole('textbox').fill(draft)
  store.updateProfileField('responsePreferences', agentValue, 'agent_tool')
  store.updateProfileField('preferredLanguage', `English-${suffix}`, 'agent_tool')
  await responseRow.getByText('该项刚刚在其他位置更新。').waitFor({ timeout: 12000 })
  await languageRow.getByText(`English-${suffix}`).waitFor()
  assert.equal(await responseRow.getByRole('textbox').inputValue(), draft)
  await responseRow.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(await responseRow.getByRole('button', { name: '保存' }).isDisabled(), true)
  assert.equal(store.getPersistentProfile().responsePreferences, agentValue)
  await mkdir(outputDirectory, { recursive: true })
  const conflictScreenshot = join(outputDirectory, 'stratagate-profile-0.2.83-conflict.png')
  await responseRow.getByText('该项刚刚在其他位置更新。').scrollIntoViewIfNeeded()
  await page.screenshot({ path: conflictScreenshot, fullPage: true })

  await responseRow.getByRole('button', { name: '载入最新内容' }).click()
  await page.waitForFunction((expected) => document.querySelector('#sg-profile-responsePreferences')?.value === expected, agentValue)
  assert.equal(await responseRow.getByRole('textbox').inputValue(), agentValue)
  await responseRow.getByRole('textbox').fill(saved)
  await responseRow.getByRole('button', { name: '保存' }).click()
  await responseRow.getByText(saved).waitFor()
  assert.equal(store.getPersistentProfile().responsePreferences, saved)
  assert.equal(store.getPersistentProfile().preferredLanguage, `English-${suffix}`)
  assert.equal(store.getProfileChanges().at(-1)?.source, 'settings')
  store.updateProfileField('reasoningLanguage', `可见思考中文-${suffix}`, 'agent_tool')
  await reasoningRow.getByText(`可见思考中文-${suffix}`).waitFor({ timeout: 12000 })
  await reasoningRow.getByRole('button', { name: '编辑' }).click()
  assert.equal(await reasoningRow.locator('input').count(), 1, 'reasoningLanguage must use a single-line editor')
  await reasoningRow.getByRole('textbox').fill(`本地思考草稿-${suffix}`)
  store.updateProfileField('reasoningLanguage', `后台思考英文-${suffix}`, 'agent_tool')
  await reasoningRow.getByText('该项刚刚在其他位置更新。').waitFor({ timeout: 12000 })
  assert.equal(await reasoningRow.getByRole('textbox').inputValue(), `本地思考草稿-${suffix}`)
  await reasoningRow.getByText('该项刚刚在其他位置更新。').waitFor()
  assert.equal(await reasoningRow.getByRole('button', { name: '保存' }).isDisabled(), true)
  assert.equal(store.getPersistentProfile().preferredLanguage, `English-${suffix}`)
  const reasoningConflictScreenshot = join(outputDirectory, 'stratagate-profile-0.2.83-reasoning-conflict.png')
  await reasoningRow.getByText('该项刚刚在其他位置更新。').scrollIntoViewIfNeeded()
  await page.screenshot({ path: reasoningConflictScreenshot, fullPage: true })
  await reasoningRow.getByRole('button', { name: '载入最新内容' }).click()
  await page.waitForFunction((expected) => document.querySelector('#sg-profile-reasoningLanguage')?.value === expected, `后台思考英文-${suffix}`)
  await reasoningRow.getByRole('textbox').fill(`思考语言已保存-${suffix}`)
  await reasoningRow.getByRole('button', { name: '保存' }).click()
  await reasoningRow.getByText(`思考语言已保存-${suffix}`).waitFor()
  assert.equal(store.getPersistentProfile().reasoningLanguage, `思考语言已保存-${suffix}`)
  assert.equal(store.getPersistentProfile().preferredLanguage, `English-${suffix}`)
  const pageScreenshot = join(outputDirectory, 'stratagate-profile-0.2.83.png')
  await page.getByRole('heading', { name: '常驻用户画像' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: pageScreenshot, fullPage: true })
  const lowerScreenshot = join(outputDirectory, 'stratagate-profile-0.2.83-lower.png')
  await page.locator('.sg-profile-group').last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: lowerScreenshot, fullPage: true })

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hiddenReads = profileReads
  await page.waitForTimeout(5700)
  assert.equal(profileReads, hiddenReads, 'Profile kept polling in a hidden browser page')
  const resumed = page.waitForRequest((request) => request.method() === 'GET' && new URL(request.url()).pathname === '/api/stratagate/profile', { timeout: 5000 })
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await resumed
  await page.getByRole('button', { name: '更多', exact: true }).click()
  const departedReads = profileReads
  await page.waitForTimeout(5700)
  assert.equal(profileReads, departedReads, 'Profile kept polling after leaving its primary tab')
  store.updateProfileField('preferredLanguage', `回到页面-${suffix}`, 'maintenance')
  await page.getByRole('button', { name: '常驻画像', exact: true }).click()
  await languageRow.getByText(`回到页面-${suffix}`).waitFor({ timeout: 12000 })
  console.log(JSON.stringify({ result: 'passed', profileReads, pageScreenshot, lowerScreenshot, conflictScreenshot, reasoningConflictScreenshot }))
} finally {
  await store.close()
  await browser.close()
}
