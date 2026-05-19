'use client'

export default function Toggle({
  on,
  onChange,
  label,
  sub,
}: {
  on: boolean
  onChange?: (val: boolean) => void
  label?: string
  sub?: string
}) {
  return (
    <label
      className="s-toggle"
      onClick={(e) => {
        e.preventDefault()
        onChange?.(!on)
      }}
    >
      <span className={'s-toggle-track' + (on ? ' on' : '')}>
        <span className="s-toggle-thumb"></span>
      </span>
      {label && (
        <span className="s-toggle-text">
          {label}
          {sub && <span className="sub">{sub}</span>}
        </span>
      )}
    </label>
  )
}
