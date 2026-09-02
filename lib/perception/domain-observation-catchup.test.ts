import { readFileSync } from 'node:fs'; import { join } from 'node:path'; import { describe,expect,it } from 'vitest'
const source=readFileSync(join(process.cwd(),'lib','caye-agent','workspace-feed.ts'),'utf8')
describe('external domain perception catch-up contract',()=>{
  it('keeps ordinary freshness on occurred_at',()=>expect(source).toContain(".gte('occurred_at',cutoff)"))
  it('admits domain events newly observed inside the window',()=>{expect(source).toContain(".like('type','domain.%')");expect(source).toContain(".gte('payload->>observed_at',cutoff)")})
  it('still uses reportability so bootstrap system events remain excluded',()=>{expect(source).toContain('REPORTABLE_SQL_FILTER');expect(source).toContain('.filter(isReportable)')})
})
