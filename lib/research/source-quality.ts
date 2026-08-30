export type ResearchSourceQuality = 'official' | 'academic-preprint' | 'academic-institution' | 'community' | 'unknown'

export function classifyResearchSourceQuality(url: string): ResearchSourceQuality {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'unknown'
  }

  if (hostname === 'arxiv.org' || hostname.endsWith('.arxiv.org')) return 'academic-preprint'
  if (hostname.endsWith('.gov') || hostname.includes('.gov.')) return 'official'
  if (hostname.endsWith('.edu') || hostname.includes('.edu.')) return 'academic-institution'
  if (hostname === 'medium.com' || hostname.endsWith('.medium.com') || hostname === 'substack.com' || hostname.endsWith('.substack.com')) return 'community'
  return 'unknown'
}
