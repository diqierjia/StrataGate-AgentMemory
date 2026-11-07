// Shared by the PR lookup and the release lookup. This file stays free of
// imports from either script so the release CLI can load both without a cycle.
const HOSTS = ['0.1.2-rc.1', '0.1.7-rc.2', '0.2.2-rc.1']

export function hasRequiredJobs(jobs, { requireWindows = true } = {}) {
  const names = ['classify', 'core (22.19.0)', 'core (24.x)']
  for (const host of HOSTS) names.push(`dsh-compatibility (ubuntu-latest, ${host})`)
  if (requireWindows) for (const host of HOSTS) names.push(`dsh-compatibility (windows-latest, ${host})`)
  return Array.isArray(jobs) && names.every(name => jobs.some(job => job.name === name && job.status === 'completed' && job.conclusion === 'success'))
}
