import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, mkdtemp, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Uses the built production MemoryPage, actual admin HTTP handlers and a real
// runtime against disposable Markdown/SQLite data. No user data or DSH profile.
const root = resolve('.')
const output = resolve(process.env.STRATAGATE_DAILY_SCREENSHOTS || join(tmpdir(), 'stratagate-daily-ui'))
const modules = resolve('.artifacts/daily-ui')
await mkdir(output, { recursive: true }); await mkdir(modules, { recursive: true })
await build({ stdin: { resolveDir: root, contents: `export { StrataGateRuntime } from './src/runtime.ts'; export { resolveConfig } from './src/config.ts'; export { handleAdminRequest } from './src/web.ts'; export { StrataGate } from './packages/core/src/index.ts'` }, outfile: join(modules, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { '@diqier/stratagate/sqlite': join(root, 'packages/core/src/sqlite.ts'), '@diqier/stratagate': join(root, 'packages/core/src/index.ts') } })
const { StrataGateRuntime, resolveConfig, handleAdminRequest, StrataGate } = await import(pathToFileURL(join(modules, 'runtime.mjs')).href)
const directory = await mkdtemp(join(tmpdir(), 'stratagate-daily-ui-data-'))
const config = resolveConfig({ database: join(directory, 'memory.db'), dailyNotesTimeZone: 'Asia/Shanghai', namespaceMode: 'global' })
const models = { isReady: () => false, onAdaptersUpdated: () => () => {} }
const runtime = new StrataGateRuntime(config, models, () => {}, async () => {}, () => undefined, async () => { throw new Error('测试：文件管理器不可用') })
const namespace = 'daily-ui:project:sample', emptyNamespace = 'daily-ui:project:empty'
for (const ns of [namespace, emptyNamespace]) {
  const memory = await StrataGate.open({ database: config.database, namespace: ns, blockTurnSize: 6 })
  await memory.appendTurn({ user: '隔离验收会话', assistant: '仅用于测试', threadId: 'daily-ui-test' }); await memory.close()
}
const notes = {
  '2026-10-28': '# 2026-10-28\n\n## 短期记忆方案\n当前：只读页面已实现，正在做实际页面验收。\n- 存储用纯 Markdown，每天一个文件，每个事项一个二级标题。\n- 写入用 `memory_daily_write`，读取用 `memory_daily_read`，不走证据门。\n- 文件：`C:/temporary/stratagate/daily/namespace/very-long-file-name-that-must-wrap-without-overflow.md`\n- 下一步：核对窄屏与深浅主题。\n\n## npm 发布说明修正\n已完成：README 与包内说明已对齐。\n- 验证：本地测试通过。\n',
  '2026-10-27': '# 2026-10-27\n## 计划验证\n当前：确认接口返回了真实日期。\n- 不向用户数据目录写入任何内容。\n',
  '2026-10-25': '# 2026-10-25\n## 整理工作\n已完成：第一阶段检查。\n',
  '2026-10-19': '# 2026-10-19\n## 较早的工作记录\n当前：保留旧日期笔记以供后续接续。\n- 产物：`docs/DSH.zh-CN.md`\n### 未知语法保留\n<script>window.dailyUnsafe=true</script>\n',
  '2026-09-03': '# 2026-09-03\n## 九月记录\n当前：更早月份也可以读取。\n',
}
const notesPath = runtime.dailyNotes.directory(namespace)
await mkdir(notesPath, { recursive: true })
for (const [date, markdown] of Object.entries(notes)) await writeFile(join(notesPath, date + '.md'), markdown)
let broken = false
async function setMode(mode) {
  config.dailyNotesEnabled = mode !== 'disabled'
  if (broken) { await rm(join(notesPath, '2026-10-28.md'), { recursive: true }); await rename(join(notesPath, '2026-10-28.held'), join(notesPath, '2026-10-28.md')); broken = false }
  if (mode === 'error') { await rename(join(notesPath, '2026-10-28.md'), join(notesPath, '2026-10-28.held')); await mkdir(join(notesPath, '2026-10-28.md')); broken = true }
}
const client = await readFile('dist/client.js', 'utf8')
const marker = /exports\.name\s*=\s*["']stratagate-dsh["']/
assert(marker.test(client), 'Built client export marker is missing')
const instrumented = client.replace(marker, 'exports.__browserTest = { MemoryPage }, exports.name = "stratagate-dsh"')
const reactRoot = resolve(process.env.STRATAGATE_TEST_REACT_ROOT || 'release-candidates/first-login-browser-fixture')
const app = await build({ stdin: { resolveDir: root, contents: `
import React from ${JSON.stringify(join(reactRoot, 'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(join(reactRoot, 'node_modules/react-dom/client.js'))};
let definition; window.__ModuleLoader__={load(value){definition=value;}};
${instrumented}
const plugin=definition.factory(name=>{if(name!=='react')throw new Error(name);return React;});
const workspaces={items:[]}, sessions={byId:{}};
createRoot(document.getElementById('root')).render(React.createElement(plugin.__browserTest.MemoryPage,{useWorkspaces:selector=>selector(workspaces),useSessions:selector=>selector(sessions)}));
` }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"development"' } })
const requests = [], errors = [], results = [], referenceChecks = []
const themes = { light: '--dsw-alias-bg-layer-2:#fff;--dsw-specific-input-major:#fff;--dsw-alias-interactive-bg-hover-solid:#f1f3f5;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-border-l2:rgba(0,0,0,.1);--dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-business-tertiary:#e8effd;--dsw-alias-state-success-primary:#1f9d55;--dsw-alias-state-success-tertiary:#e6f7ed;', dark: '--dsw-alias-bg-layer-2:#1f2023;--dsw-specific-input-major:#26282c;--dsw-alias-interactive-bg-hover-solid:#2d3035;--dsw-alias-label-primary:#eceef1;--dsw-alias-label-secondary:#9a9fa6;--dsw-alias-border-l2:rgba(255,255,255,.09);--dsw-alias-state-business-primary:#5b8def;--dsw-alias-state-business-tertiary:rgba(91,141,239,.14);--dsw-alias-state-success-primary:#3ccf7a;--dsw-alias-state-success-tertiary:rgba(60,207,122,.13);' }
const server = createServer(async (req,res)=>{
  const url=new URL(req.url,'http://fixture')
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>html,body{margin:0}html{'+themes[url.searchParams.get('theme')||'light']+'}#root{width:100%;min-width:0}body{background:var(--dsw-alias-bg-layer-2)}</style><div id="root"></div><script src="/app.js"></script>');return}
  if(url.pathname==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(app.outputFiles[0].text);return}
  if(url.pathname==='/favicon.ico'){res.statusCode=204;res.end();return}
  await handleAdminRequest(runtime,req,{get statusCode(){return res.statusCode},set statusCode(v){res.statusCode=v},setHeader:(k,v)=>res.setHeader(k,v),end:body=>{requests.push({path:url.pathname,query:url.search,status:res.statusCode});res.end(body)}})
})
await new Promise(done=>server.listen(0,'127.0.0.1',done))
const port=server.address().port
const browser=await chromium.launch({channel:'msedge',headless:true})
console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,pid:process.pid,output,temporaryData:directory}))
try {
  for(const theme of ['light','dark']) for(const width of [640,320]) {
    await setMode('normal')
    const context=await browser.newContext({viewport:{width,height:1200},colorScheme:theme})
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message))
    await page.goto(`http://127.0.0.1:${port}/?theme=${theme}`)
    await page.locator('.sg-tabs button').first().waitFor()
    assert.deepEqual(await page.locator('.sg-tabs button').allTextContents(),['常驻画像','会话记忆','短期记忆','长期记忆','更多'])
    assert.equal(await page.locator('.sg-tabs [aria-current="page"]').textContent(),'会话记忆')
    await page.getByRole('combobox',{name:'当前工作区'}).selectOption(namespace)
    const enter=async()=>{await page.locator('.sg-tabs button').filter({hasText:/^短期记忆$/}).click();await page.locator('.sg-daily-head').waitFor()}
    const remount=async()=>{await page.locator('.sg-tabs button').filter({hasText:/^会话记忆$/}).click();await enter()}
    const capture=async state=>{
      await page.locator('.sg-daily .sg-loading').waitFor({state:'detached'})
      await page.mouse.move(width - 2, 1190)
      await page.screenshot({path:join(output,`${theme}-${width}-${state}.png`),fullPage:true,animations:'disabled'})
      const layout=await page.evaluate(()=>{
        const panel=document.querySelector('.sg-memory'),box=panel.getBoundingClientRect()
        const overflow=[...panel.querySelectorAll('*')].filter(el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&s.position!=='absolute'&&(r.right>box.right+.6||r.left<box.left-.6)}).map(el=>el.className).slice(0,12)
        return {panelWidth:box.width,scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,overflow,labels:[...document.querySelectorAll('.sg-tabs button')].map(el=>({label:el.textContent,truncated:el.scrollWidth>el.clientWidth,whiteSpace:getComputedStyle(el).whiteSpace})),numSize:document.querySelector('.sg-daily-num')?getComputedStyle(document.querySelector('.sg-daily-num')).fontSize:null}
      })
      assert.equal(layout.scrollWidth<=layout.clientWidth,true,JSON.stringify({theme,width,state,layout}))
      assert.equal(layout.overflow.length,0,JSON.stringify({theme,width,state,layout}))
      assert(layout.labels.every(label=>!label.truncated&&label.whiteSpace==='nowrap'))
      results.push({theme,width,state,screenshot:join(output,`${theme}-${width}-${state}.png`),...layout})
    }
    await enter();await page.locator('.sg-daily-note').waitFor();await capture('default')
    const referenceFile = process.env.STRATAGATE_DAILY_REFERENCE || '.lavish/short-term-notes-reference.html'
    if (await readFile(referenceFile).then(() => true, () => false)) {
      const reference = await context.newPage()
      await reference.setViewportSize({width:900,height:1200})
      await reference.goto(pathToFileURL(resolve(referenceFile)).href)
      await reference.locator(`[data-group="theme"] [data-v="${theme}"]`).click()
      await reference.locator(`[data-group="width"] [data-v="${width === 320 ? 'narrow' : 'wide'}"]`).click()
      await reference.screenshot({path:join(output, `reference-${theme}-${width}.png`), fullPage:true, animations:'disabled'})
      const pairs = [['.stm-head h2','.sg-daily-head h2',['fontSize','fontWeight']], ['.day-num','.sg-daily-num',['fontSize','fontWeight']], ['.day.selected','.sg-daily-day.selected',['borderRadius','backgroundColor','borderTopColor']], ['.note-date h3','.sg-daily-note-date h3',['fontSize','fontWeight']], ['.note-item h4','.sg-daily-item h4',['fontSize','fontWeight']], ['.note-status b','.sg-daily-status b',['backgroundColor','color','borderRadius']]]
      for (const [expectedSelector, actualSelector, properties] of pairs) {
        const values = async (target, selector) => target.locator(selector).first().evaluate((el, properties) => Object.fromEntries(properties.map(property => [property,getComputedStyle(el)[property]])), properties)
        const expected = await values(reference, expectedSelector), actual = await values(page, actualSelector)
        assert.deepEqual(actual, expected, `${theme}/${width}/${actualSelector}`)
        referenceChecks.push({theme,width,selector:actualSelector,expected,actual})
      }
      await reference.close()
    }
    assert.equal(await page.locator('.sg-daily-day').count(),3)
    assert.deepEqual(await page.locator('.sg-daily-rel').allTextContents(),['今天','昨天','3 天前'])
    await page.getByRole('button',{name:'查看更早日期'}).click();await page.getByRole('dialog',{name:'选择日期'}).waitFor();await capture('calendar')
    assert.equal(await page.getByRole('button',{name:'下个月',exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'上个月',exact:true}).click();assert.equal(await page.getByRole('button',{name:'上个月',exact:true}).isDisabled(),true)
    await page.getByRole('button',{name:'下个月',exact:true}).click();await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('button',{name:'查看更早日期'}).evaluate(el=>el===document.activeElement),true)
    await page.getByRole('button',{name:'查看更早日期'}).click();await page.locator('.sg-daily-head h2').click();await page.getByRole('dialog',{name:'选择日期'}).waitFor({state:'detached'})
    await page.getByRole('button',{name:'查看更早日期'}).click();await page.getByRole('button',{name:'10月19日',exact:true}).click();await page.getByText('较早的工作记录',{exact:true}).waitFor();await capture('older')
    assert.equal(await page.getByText('不在最近三天',{exact:true}).count(),1)
    assert.equal(await page.evaluate(()=>window.dailyUnsafe),undefined)
    await page.getByRole('button',{name:'回到今天'}).click();await page.getByText('只读页面已实现，正在做实际页面验收。',{exact:true}).waitFor()
    await page.getByRole('button',{name:'打开笔记文件夹'}).click();await page.locator('.sg-storage-feedback.failed').waitFor();assert.match(await page.locator('.sg-storage-feedback.failed').innerText(),/文件管理器不可用/)
    await page.getByRole('combobox',{name:'当前工作区'}).selectOption(emptyNamespace);await page.getByText('还没有笔记',{exact:true}).waitFor();await capture('empty')
    await page.getByRole('combobox',{name:'当前工作区'}).selectOption(namespace);await page.locator('.sg-daily-note').waitFor()
    await setMode('error');await remount();await page.getByText('暂时无法读取笔记',{exact:true}).waitFor();await capture('error')
    await setMode('normal');await page.getByRole('button',{name:'重新读取'}).click();await page.getByText('只读页面已实现，正在做实际页面验收。',{exact:true}).waitFor()
    await setMode('disabled');await remount();await page.getByText('已暂停注入',{exact:true}).waitFor();await capture('disabled')
    const dailyReads=requests.filter(r=>r.path==='/api/stratagate/daily').length
    await page.waitForTimeout(350)
    assert.equal(requests.filter(r=>r.path==='/api/stratagate/daily').length,dailyReads,'Daily page must not poll')
    await context.close()
  }
  assert.deepEqual(errors,[])
  console.log(`Passed: ${results.length} built-page screenshot cases; calendar, keyboard, workspace switch, read errors, retry, open-folder errors, safe Markdown, no overflow.`)
} finally {
  await writeFile(join(output,'browser-results.json'),JSON.stringify({browser:browser.version(),results,referenceChecks,requests,errors},null,2))
  await browser.close();await new Promise(done=>server.close(done));await runtime.close();await rm(directory,{recursive:true,force:true})
}
