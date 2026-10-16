import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function checkFeedbackPolicy(root = fileURLToPath(new URL('../', import.meta.url))) {
  const agent = readFileSync(join(root, 'src/feedback-policy.ts'), 'utf8')
    .match(/export const AGENT_FEEDBACK_ENABLED = (true|false)\b/)?.[1]
  const client = readFileSync(join(root, 'src/client.js'), 'utf8')
    .match(/const GITHUB_FEEDBACK_ENABLED = (true|false)\b/)?.[1]
  if (!agent || !client || agent !== client) {
    throw new Error('Feedback gates must match: AGENT_FEEDBACK_ENABLED=' + agent + ', GITHUB_FEEDBACK_ENABLED=' + client)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkFeedbackPolicy(process.argv[2] ? resolve(process.argv[2]) : undefined)
}
