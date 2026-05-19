export default function CayeMark({ size = 22 }: { size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'conic-gradient(from 0deg, #1e6157, #f4b942, #e85a3c, #1e6157)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        position: 'relative',
        boxShadow: '0 0 0 2px rgba(30,97,87,0.18)',
      }}
    >
      <span
        style={{
          width: size * 0.5,
          height: size * 0.5,
          borderRadius: '50%',
          background: 'var(--tc-bg-soft)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: size * 0.32,
          fontWeight: 700,
          color: 'var(--tc-teal)',
          fontFamily: 'var(--font-sans)',
          letterSpacing: '-0.02em',
        }}
      >
        C
      </span>
    </span>
  )
}
