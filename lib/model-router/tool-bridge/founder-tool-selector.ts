import 'server-only'
import { TOOL_REGISTRY } from '@/lib/caye-agent/tools/registry'

/**
 * OpenAI-compatible backends accept at most 128 tools per request. Caye has
 * grown beyond that, so Founder Direct cannot keep shipping the entire
 * back-office registry on every turn.
 *
 * This selector is deterministic and authority-neutral: it only decides which
 * real registry entries the model may SEE on this turn. It never creates a
 * synthetic tool, changes roles/risk, or bypasses any server-side gate.
 */
export const MAX_FOUNDER_DIRECT_TOOLS = 112

const STOP = new Set([
  'the','a','an','and','or','to','of','for','in','on','at','is','are','be','my','me','i','we','you','it','this','that','with','from','do','can','could','would','should','please',
])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
}

const DOMAIN_HINTS: Array<{ re: RegExp; terms: string[] }> = [
  { re: /\b(job|jobs|career|apply|application|resume|recruit|hiring|interview|ats|greenhouse|lever)\b/i, terms: ['job','application','career','resume','candidate','ats','greenhouse','recruit','hiring'] },
  { re: /\b(research|intelligence|evidence|claim|belief|trend|market|source|investigat\w*|verify|verification)\b|\blook into\b|\bkeep an eye on\b|\bi heard\b/i, terms: ['research','intelligence','evidence','claim','belief','source','trend','canonical','investigation','verify'] },
  { re: /\b(email|gmail|inbox|message|reply|draft)\b/i, terms: ['email','gmail','inbox','message','reply','draft'] },
  { re: /\b(booking|tour|reservation|guest|customer|lead|quote|payment)\b/i, terms: ['booking','tour','reservation','guest','customer','lead','quote','payment'] },
  { re: /\b(file|image|photo|pdf|document|attachment|artifact)\b/i, terms: ['file','image','photo','pdf','document','attachment','artifact'] },
  { re: /\b(goal|objective|direction|priority|plan|strategy)\b/i, terms: ['goal','objective','direction','priority','plan','strategy'] },
]

function scoreTool(message: string, tool: { name: string; description: string; risk: string }): number {
  const query = new Set(words(message))
  const hay = new Set(words(`${tool.name} ${tool.description}`))
  let score = 0
  for (const token of query) if (hay.has(token)) score += 12

  const loweredName = tool.name.toLowerCase()
  for (const hint of DOMAIN_HINTS) {
    if (!hint.re.test(message)) continue
    if (hint.terms.some((term) => loweredName.includes(term) || hay.has(term))) score += 45
  }

  // Read tools are useful grounding primitives and cheap to expose when ties
  // remain. This is only a manifest-ranking tie-breaker, not execution policy.
  if (tool.risk === 'read') score += 1
  return score
}

export function selectFounderToolNames(message: string, maxTools = MAX_FOUNDER_DIRECT_TOOLS): string[] {
  const eligible = TOOL_REGISTRY.filter((tool) => tool.modes.includes('back-office'))
  if (eligible.length <= maxTools) return eligible.map((tool) => tool.name)

  return eligible
    .map((tool, index) => ({ tool, index, score: scoreTool(message, tool) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Math.min(maxTools, 127)))
    .map(({ tool }) => tool.name)
}
