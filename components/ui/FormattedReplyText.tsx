import { Fragment } from 'react'

type Block = { type: 'p'; text: string } | { type: 'ul'; items: string[] }

const BULLET_RE = /^[-•]\s+(.*)/
const BOLD_RE = /(\*\*[^*]+\*\*)/g

function formatInline(text: string) {
  return text.split(BOLD_RE).map((part, i) =>
    /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>
  )
}

function toBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: string[] = []

  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = [] } }
  const flushList = () => { if (list.length) { blocks.push({ type: 'ul', items: list }); list = [] } }

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const bullet = BULLET_RE.exec(line)
    if (bullet) {
      flushPara()
      list.push(bullet[1])
    } else if (line === '') {
      flushList()
      flushPara()
    } else {
      flushList()
      para.push(raw)
    }
  }
  flushList()
  flushPara()
  return blocks
}

// Caye's replies are plain-text with light markdown conventions (a "- "
// bullet per line, occasional **bold**) rather than real markdown — this
// renders just enough structure (paragraphs, real list markers, bold) to
// read cleanly instead of showing raw hyphens and run-on whitespace.
export function FormattedReplyText({ text, style }: { text: string; style?: React.CSSProperties }) {
  const blocks = toBlocks(text)
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          // Bullets always read left-to-right regardless of which side of a
          // chat thread the block sits on — force left alignment so a
          // right-aligned bubble doesn't flip list markers/text backwards.
          <ul key={i} style={{
            margin: i === 0 ? 0 : '8px 0 0', padding: 0, paddingLeft: 20,
            display: 'flex', flexDirection: 'column', gap: 2,
            ...style, textAlign: 'left', listStylePosition: 'outside', listStyleType: 'disc',
          }}>
            {b.items.map((item, j) => (
              <li key={j} style={{ margin: 0, padding: 0, fontSize: 'inherit', lineHeight: 'inherit' }}>{formatInline(item)}</li>
            ))}
          </ul>
        ) : (
          <p key={i} style={{ margin: i === 0 ? 0 : '8px 0 0', whiteSpace: 'pre-wrap', ...style }}>{formatInline(b.text)}</p>
        )
      )}
    </>
  )
}
