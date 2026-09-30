import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { WorkBuddyRuntime } from '../src/runtime.js'

const temporaryDirectories: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function runtime(): Promise<WorkBuddyRuntime> {
  const dataDir = await mkdtemp(join(tmpdir(), 'stratagate-workbuddy-test-'))
  temporaryDirectories.push(dataDir)
  return new WorkBuddyRuntime(resolveConfig({
    STRATAGATE_DATA_DIR: dataDir,
    STRATAGATE_BLOCK_TURN_SIZE: '1',
    STRATAGATE_DISABLE_WORKBUDDY_MODEL: '1',
  }, join(dataDir, 'project')))
}

describe('WorkBuddyRuntime', () => {
  it('makes block scope and empty reasons explicit', async () => {
    const memory = await runtime()
    await memory.appendTurn({ user: 'thread A marker', assistant: 'saved', threadId: 'thread-a', receiptId: 'turn-a' })
    await memory.processPending()

    const session = await memory.getBlocks('thread-b')
    expect(session).toMatchObject({
      scope: 'session',
      threadId: 'thread-b',
      results: [],
      namespaceBlockCount: 1,
      emptyReason: 'blocks_exist_in_other_threads',
    })

    const namespace = await memory.getBlocks('thread-b', 'namespace')
    expect(namespace).toMatchObject({ scope: 'namespace', namespaceBlockCount: 1, results: [] })
  })

  it('persists L5 first and derives blocks in the background', async () => {
    const memory = await runtime()
    await memory.appendTurn({
      user: 'Remember that the release channel is canary.',
      assistant: 'I will use the canary release channel.',
      receiptId: 'turn-1',
    })

    expect(await memory.status()).toMatchObject({
      counts: { turns: 1, openTailMessages: 2, blocks: 0 },
    })

    await memory.processPending()

    expect(await memory.status()).toMatchObject({
      counts: { turns: 1, openTailMessages: 0, blocks: 1 },
    })
  })

  it('creates an evidence batch, applies the gate, and records adoption idempotently', async () => {
    const memory = await runtime()
    await memory.appendTurn({
      user: 'Our deployment target is Singapore.',
      assistant: 'Deployment target noted as Singapore.',
      receiptId: 'turn-1',
    })

    const recalled = await memory.initialContext('session-1', 'Where is our deployment target?')
    expect(recalled.batch?.results.some((item) => item.kind === 'tail')).toBe(true)
    expect(recalled.context).toContain('<stratagate_memory')

    const ref = recalled.batch?.evidenceRefs[0]
    expect(ref).toBeTruthy()
    const assessment = await memory.assess(recalled.batch!.batchId, {
      verdict: 'sufficient',
      evidence_refs: [ref!],
      fit: 'Directly states the deployment target.',
      missing: '',
      next_strategy: 'answer',
    })
    expect(await memory.recordUse(assessment.id)).not.toHaveProperty('starPrompt')
    expect(await memory.recordUse(assessment.id)).not.toHaveProperty('starPrompt')

    expect(await memory.status()).toMatchObject({ counts: { usageReceipts: 1 } })
  })

  it('offers the GitHub Star card once after three evidence-backed uses', async () => {
    const memory = await runtime()
    await memory.appendTurn({
      user: 'Our deployment target is Singapore.',
      assistant: 'Deployment target noted as Singapore.',
      receiptId: 'turn-1',
    })
    const recalled = await memory.initialContext('session-1', 'Where is our deployment target?')
    const ref = recalled.batch!.evidenceRefs[0]!
    const results = []
    for (let index = 0; index < 4; index += 1) {
      const assessment = await memory.assess(recalled.batch!.batchId, {
        verdict: 'sufficient',
        evidence_refs: [ref],
        fit: 'Direct evidence.',
        missing: '',
        next_strategy: 'answer',
      })
      results.push(await memory.recordUse(assessment.id))
    }

    expect(results[0]).not.toHaveProperty('starPrompt')
    expect(results[1]).not.toHaveProperty('starPrompt')
    expect(results[2]).toMatchObject({
      starPrompt: {
        usageRecords: 3,
        repositoryUrl: 'https://github.com/diqierjia/StrataGate-AgentMemory',
      },
    })
    expect(results[3]).not.toHaveProperty('starPrompt')
  })

  it('generates Events and Elements in the background with a configured model', async () => {
    let previousTargetMessageId = 'non-target-message';
    const model = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const system = body.messages[0].content as string
        const payload = JSON.parse(body.messages[1].content)
        let result: unknown
        if (system.startsWith('You compress')) {
          result = {
            l0Title: 'Deployment decision',
            l0Tags: ['deployment'],
            l1Summary: 'The project deployment target was discussed.',
            l2Keypoints: ['Deployment target: Singapore'],
            shouldExtract: true,
          }
        } else if (system.startsWith('You are the StrataGate Event Extractor')) {
          result = {
            shouldExtract: true,
            reason: 'A durable project decision was found.',
            events: [{
              title: 'Deployment target selected',
              summary: 'The deployment target is Singapore.',
              tags: ['deployment', 'singapore'],
              quotes: ['Our deployment target is Singapore.'],
              sourceMessageIds: [payload.target.messages[0].id],
              temporal: { eventType: 'decision' },
              scope: 'project',
              criticality: 'routine',
            }, {
              title: 'Invalid mixed-source Event', summary: 'This Event must be rejected.',
              sourceMessageIds: [payload.target.messages[0].id, previousTargetMessageId],
            }],
          }
          previousTargetMessageId = payload.target.messages[0].id
        } else {
          result = {
            reason: 'Project state updated from the deployment decision.',
            changes: [{
              element: { name: 'Current project', type: 'project', aliases: [] },
              operation: 'set_state',
              key: 'deployment_target',
              mode: 'state',
              value: 'Singapore',
              sourceEventIds: [payload.events[0].id],
              confidence: 0.98,
            }],
          }
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }))
      })
    })
    servers.push(model)
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
    const address = model.address()
    if (!address || typeof address === 'string') throw new Error('Mock model did not bind a TCP port')

    const dataDir = await mkdtemp(join(tmpdir(), 'stratagate-workbuddy-model-test-'))
    temporaryDirectories.push(dataDir)
    const memory = new WorkBuddyRuntime(resolveConfig({
      STRATAGATE_DATA_DIR: dataDir,
      STRATAGATE_BLOCK_TURN_SIZE: '1',
      STRATAGATE_DISABLE_WORKBUDDY_MODEL: '1',
      STRATAGATE_MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      STRATAGATE_MODEL: 'mock-memory-model',
    }, join(dataDir, 'project')))
    await memory.appendTurn({ user: 'Our deployment target is Singapore.', assistant: 'Noted.', receiptId: 'turn-1' })
    await memory.appendTurn({ user: 'Proceed with the release.', assistant: 'Proceeding.', receiptId: 'turn-2' })

    await memory.processPending()

    expect(await memory.status()).toMatchObject({
      mode: 'full',
      counts: { blocks: 2, events: 2, elements: 1 },
    })
    const elements = await memory.searchElements('Singapore', 'session-1')
    expect(elements.results[0]).toMatchObject({ kind: 'element', content: 'Singapore' })
  })

  it('uses WorkBuddy lite by default without an external API key', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'stratagate-workbuddy-lite-test-'))
    temporaryDirectories.push(dataDir)
    const fakeCli = join(dataDir, 'fake-codebuddy.mjs')
    await writeFile(fakeCli, `
const chunks = []
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const args = process.argv.slice(2)
const system = args[args.indexOf('--system-prompt') + 1]
let result
if (system.startsWith('You compress')) {
  result = { l0Title: 'Deployment', l0Tags: ['deployment'], l1Summary: 'Deployment summary.', l2Keypoints: ['Singapore'], shouldExtract: true }
} else if (system.startsWith('You are the StrataGate Event Extractor')) {
  result = {
    shouldExtract: true,
    reason: 'durable decision',
    events: [{
      title: 'Deployment target selected', summary: 'Singapore selected.',
      tags: ['deployment'], quotes: ['Singapore'], sourceMessageIds: [payload.target.messages[0].id],
      temporal: { eventType: 'decision' }, scope: 'project', criticality: 'routine'
    }]
  }
} else {
  result = {
    reason: 'project state',
    changes: [{
      element: { name: 'Current project', type: 'project', aliases: [] }, operation: 'set_state',
      key: 'deployment_target', mode: 'state', value: 'Singapore',
      sourceEventIds: [payload.events[0].id], confidence: 0.99
    }]
  }
}
process.stdout.write(JSON.stringify({ structured_output: result }))
`, 'utf8')
    const memory = new WorkBuddyRuntime(resolveConfig({
      STRATAGATE_DATA_DIR: dataDir,
      STRATAGATE_BLOCK_TURN_SIZE: '1',
      STRATAGATE_WORKBUDDY_CLI: fakeCli,
    }, join(dataDir, 'project')))
    await memory.appendTurn({ user: 'Deploy to Singapore.', assistant: 'Noted.', receiptId: 'turn-1' })
    await memory.appendTurn({ user: 'Continue.', assistant: 'Continuing.', receiptId: 'turn-2' })

    await memory.processPending()

    expect(await memory.status()).toMatchObject({
      mode: 'full',
      model: { provider: 'workbuddy', model: 'lite' },
      counts: { blocks: 2, events: 2, elements: 1 },
    })
  })
})
