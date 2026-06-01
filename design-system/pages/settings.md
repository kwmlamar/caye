# Settings Page — Design Guidelines

This page override extends the `design-system/MASTER.md` specification for the **Settings** view of Caye.

---

## 1. Top Header Structure

The Settings page top header is visual-first, utilizing warm, matte tones and precise grid spacing to maintain alignment with the **"ink-on-parchment"** Caribbean SaaS aesthetic.

### Left Navigation (Breadcrumbs)
- **Pattern:** `Workspace  /  Settings  /  ActiveTab`
- **Font & Size:** Inter body font, sized at `text-[13px]` (`font-normal`) with `gap-3` spacing.
- **Colors:** 
  - Muted states (`Workspace`, `Settings`): Slate gray `#5A6672` for minimum high contrast.
  - Slashes (`/`): Light warm gray `#C4C0BA` to recede into the background.
  - Active state (`activeLabel`): Jet-black bold `font-bold text-[#0B1419]`.

### Right Controls
- **Search Everything Input:**
  - Sized at `w-[280px]`.
  - Pure white background (`bg-white`) to stand out cleanly against the warm page background.
  - Sub-pixel borders `border border-[#EBE7DF]` with extremely subtle neutral shadow `shadow-[0_1px_2px_rgba(0,0,0,0.02)]`.
  - Placeholder: `"Search everything.."` in `#8A94A0` with a sharp Phosphor/SVG magnifying glass icon on the left.
- **Sidebar Toggle Button:**
  - Square-shaped `w-10 h-10` matching the vertical height of the search container.
  - Background is white (`bg-white`) with the same border (`border border-[#EBE7DF]`) and subtle shadow.
  - Hover states provide immediate visual feedback: `hover:bg-[#F7F4EF]/60` transitioning at `150ms`.

---

## 2. Interactive States & Collapsible Navigation

- **Settings Sidebar:** The left-hand Settings sidebar can be collapsed completely by clicking the sidebar toggle button.
- **Collapsible aside classes:**
  ```tsx
  className={cn(
    "w-[320px] shrink-0 flex flex-col bg-[#FAF8F3] border-r border-[#EBE7DF] overflow-x-hidden overflow-y-auto py-9 px-6 select-none transition-all duration-300 ease-in-out",
    isSidebarCollapsed && "w-0 px-0 py-0 border-r-0 opacity-0 pointer-events-none"
  )}
  ```
- **Transition details:** To prevent layout jank or ugly wrapping of settings menu options during transition, the sidebar content is wrapped in a container set to a minimum width of `min-w-[272px]`. This guarantees a smooth, sliding premium animation.
