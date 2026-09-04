import type { CSSProperties } from 'react'

/**
 * Shared visual language for the founder Command Center — a systematic
 * surface hierarchy instead of one-off borders/backgrounds per component.
 * 2026-08-13 pass: "the interface should almost disappear; Caye should
 * feel alive inside it." Moved from founder-home/ to here (2026-08-14)
 * once the Inbox redesign needed the same tokens — this is genuinely
 * shared across every founder-facing surface, not Home-specific.
 *
 * Hierarchy:
 *   environment  — near-black, nearly invisible
 *   information  — clean text, minimal chrome, separated by spacing and
 *                  tonal difference rather than borders
 *   Caye         — luminous, alive (CayePresence owns this)
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

/** A thin pane floating in the environment — the composer, section
 *  backgrounds. Not an opaque card; the page shows through it. Only for
 *  surfaces that sit over calm/empty background — see popoverSurface for
 *  anything that needs to sit ON TOP of real content (text, other UI) and
 *  stay legible regardless of what's behind it. */
export function glass(alpha = 0.04): CSSProperties {
  return {
    background: `rgba(255,255,255,${alpha})`,
    backdropFilter: 'blur(18px) saturate(150%)',
    WebkitBackdropFilter: 'blur(18px) saturate(150%)',
  }
}

/** LEVEL 3 of the surface hierarchy — temporary foreground overlays
 *  (popovers, dropdowns, menus, command palettes). These should read as a
 *  clearly separate layer from the near-black environment, similar to the
 *  tonal lift used by modern command/chat interfaces, while still keeping
 *  Caye's cooler, restrained material language. High opacity preserves
 *  legibility; a small amount of blur keeps the surface from feeling flat.
 *
 *  `isolation: isolate` guarantees the panel composites independently of
 *  surrounding glass surfaces so future layout changes cannot collapse the
 *  intended foreground/background separation. */
export function popoverSurface(): CSSProperties {
  return {
    background: 'rgba(28,29,33,0.98)',
    backdropFilter: 'blur(16px) saturate(125%)',
    WebkitBackdropFilter: 'blur(16px) saturate(125%)',
    isolation: 'isolate',
  }
}

/** A popover that opens inside the Command sidebar. It uses the same lifted
 *  foreground idea as popoverSurface(), but one step brighter so workspace,
 *  account, and thread menus are immediately distinguishable from the rail
 *  beneath them. This keeps the app's near-black foundation intact while
 *  making transient menus feel intentional instead of disappearing into the
 *  background. */
export function sidebarPopoverSurface(): CSSProperties {
  return {
    background: 'rgba(38,39,43,0.98)',
    backdropFilter: 'blur(18px) saturate(120%)',
    WebkitBackdropFilter: 'blur(18px) saturate(120%)',
    isolation: 'isolate',
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

/** Faint row separator for lists (Working Now, Caye's Log, conversation
 *  threads) — a tonal hint, not a boxed table. */
export const rowDivider = '1px solid rgba(255,255,255,0.045)'

/** Selected/active row — nav items, list rows, tabs. A neutral tonal lift,
 *  not a wash of Caye's aqua across the row. Aqua is her color: live
 *  badges, her authored threads, voice pulses. A flat aqua fill behind
 *  every selected row spends that signal on plain "you are here" state
 *  until it just reads as "the app's blue" — this keeps selection legible
 *  through weight and brightness alone. */
export function selectedRow(active: boolean): CSSProperties {
  return active
    ? { background: 'rgba(255,255,255,0.065)' }
    : {}
}

/** A near-invisible container boundary — hairline outline, almost no
 *  fill — for a list/table that should read like Claude or ChatGPT's own
 *  minimal surfaces (content grouped by whitespace + row dividers) rather
 *  than a filled "card" floating on the page. Distinct from glass()/
 *  popoverSurface() above, which are for panes that need to read as a
 *  genuine physical layer (a popover, the composer); this is for content
 *  that's still part of the page, just visually grouped — Operations
 *  tables/lists (2026-08-26) moved off a flat CARD_BG fill onto this. */
export const quietPanel: CSSProperties = {
  background: 'rgba(255,255,255,0.015)',
  boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.06)',
}

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
