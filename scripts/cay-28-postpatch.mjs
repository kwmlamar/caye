import fs from 'node:fs'

const path = 'lib/caye-agent/tools/high-risk-gate.ts'
let source = fs.readFileSync(path, 'utf8')
const replacements = [
  ["      const { data: existing } = await existingQuery", "      let { data: existing } = await existingQuery"],
  ["        existing = ownerExisting", "        existing = ownerExisting.data"],
]
for (const [from, to] of replacements) {
  const count = source.split(from).length - 1
  if (count !== 1) throw new Error(`${path}: expected one match for ${from}, found ${count}`)
  source = source.replace(from, to)
}
fs.writeFileSync(path, source)
console.log('CAY-28 high-risk ownership patch normalized')
