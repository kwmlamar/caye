import type { CSSProperties } from 'react'

/**
 * Shared visual language for the founder Command Center — a systematic
 * surface hierarchy instead of one-off borders/backgrounds per component.
 * 2026-08-13 pass: "the interface should almost disappear; Caye should
 * feel alive inside it."
 *
 * Hierarchy:
 *   environment  — near-black, nearly invisible
 *   information  — clean text, minimal chrome, separated by spacing and
 *                  tonal difference rather than borders
 *   Caye         — luminous, alive (CayeCore owns this)
 *   attention    — warm, selective, never alarming
 *
 * Borders are not banned — they're the wrong DEFAULT. A border earns its
 * place when it genuinely improves comprehension (e.g. a data table row)
 * or accessibility (focus rings), not as the standard way to say "this is
 * a section."
 */

export const ENV_BG = '#0a0a0c'
export const TEXT = '#f4f4f5'
export const TEXT_MUTED = '#a1a1aa'
export const TEXT_QUIET = '#71717a'
export const AQUA = '#4EBECE'
export const GOLD = '#FFE4AF'
export const OCEAN = '#0766A3'
export const ROSE = '#fb7185'
export const EMERALD = '#34d399'
export const GRADIENT = `linear-gradient(90deg, ${OCEAN}, ${AQUA}, ${GOLD})`

/** A thin pane floating in the environment — popovers, the composer, the
 *  attention surface. Not an opaque card; the page shows through it. */
export function glass(alpha = 0.04): CSSProperties {
  return {
    background: `rgba(255,255,255,${alpha})`,
    backdropFilter: 'blur(18px) saturate(150%)',
    WebkitBackdropFilter: 'blur(18px) saturate(150%)',
  }
}

/** Replaces a hard outline on a floating pane: a faint inner top
 *  highlight (light catching the upper edge) + a diffuse shadow for
 *  depth. No border color. */
export const paneShadow = '0 1px 0 rgba(255,255,255,0.05) inset, 0 16px 40px rgba(0,0,0,0.4)'
export const paneShadowSoft = '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.3)'

/** Warm, selective, never alarming — the one place gold gets to lead. */
export const attentionSurface: CSSProperties = {
  background: 'rgba(255,228,175,0.045)',
  boxShadow: 'inset 0 0 0 1px rgba(255,228,175,0.07)',
}

/** Faint row separator for lists (Working Now, Caye's Log) — a tonal
 *  hint, not a boxed table. */
export const rowDivider = '1px solid rgba(255,255,255,0.045)'

/** Baseline outline reset + focus-visible restoration. Applied once at
 *  the root; components don't need their own focus handling. */
export const focusResetCss = `
  .caye-founder button, .caye-founder a, .caye-founder input, .caye-founder [tabindex] {
    outline: none;
  }
  .caye-founder button:focus-visible, .caye-founder a:focus-visible,
  .caye-founder input:focus-visible, .caye-founder [tabindex]:focus-visible {
    outline: 2px solid ${AQUA}; outline-offset: 2px;
  }
`
