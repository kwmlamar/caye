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
 *  (popovers, dropdowns, menus, command palettes) that MUST read as a
 *  physical layer sitting above the application, not a tint over it.
 *  Readability wins over glass purity here: high opacity (0.96, inside
 *  the 0.94-0.98 "clearly foreground" band) with just enough blur left
 *  to keep some material character at the edges.
 *
 *  `isolation: isolate` still matters even with the paint-order bug
 *  fixed at its actual source (the header now has an explicit z-index —
 *  see FounderHome's header comment): it guarantees this panel composites
 *  independently of whatever ancestor/sibling glass surfaces are doing,
 *  so a future layout change nearby can't reopen the same class of bug. */
export function popoverSurface(): CSSProperties {
  return {
    background: 'rgba(15,15,18,0.96)',
    backdropFilter: 'blur(14px) saturate(140%)',
    WebkitBackdropFilter: 'blur(14px) saturate(140%)',
    isolation: 'isolate',
  }
}

/** A popover that opens INSIDE an already-dark, controlled surface (the
 *  Command sidebar) rather than floating over arbitrary page content.
 *  popoverSurface() above is tuned for the latter — max legibility over any
 *  possible background, which is why it reads as a hard foreground "card."
 *  Inside the sidebar there's no arbitrary content to guard against (it's
 *  the same near-black tone throughout), so that same treatment instead
 *  reads as a mismatched slab of a different material dropped onto a
 *  surface that's deliberately flat and shadow-free everywhere else. Same
 *  opacity (legibility is unchanged) — just matched to the sidebar's own
 *  near-black rather than a generic one, with the softer ambient shadow
 *  (paneShadowSoft) instead of popoverSurface's heavy drop shadow. Used by
 *  WorkspaceSwitcher and FounderProfile's account menu.
 *
 *  Background is ENV_BG itself (not a nearby-but-different near-black) —
 *  literally the app's own root tone, so "consistent with the rest of the
 *  app" is true by construction rather than by eyeballing a close color.
 *  No saturate() boost, unlike glass()/popoverSurface() above: at this
 *  opacity almost nothing behind the panel shows through anyway, so
 *  saturate had no job to do here except add a faint, unintended color
 *  cast. */
export function sidebarPopoverSurface(): CSSProperties {
  return {
    background: `${ENV_BG}f7`,
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
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
