# OXIS 2 interface: audit and redesign plan

The native interface (`crates/oxis-app`) works, but it doesn't yet look or
behave like a finished product. This is what's wrong with it, the design
system that replaces it, and the order the work lands in. The engine
(`oxide`, `oxide-terminal`) isn't touched by any of it.

## Audit (as of 2026-10-15)

Measured on snapshots at 1280×800, 1366×768 and 720×460 (`oxis --drive`).

**Identity**
- The title bar's mark is two plain circles, not the OXIS logo (the
  folded-ribbon O).
- ImGui's defaults leak through: a blue checkbox, a default combo arrow,
  and boxed ImGui tooltips ("Run", "Settings") that sit on top of
  content.

**Layout and hierarchy**
- Home is two bordered boxes with fixed heights. They leave two thirds of
  a large window empty and cramp a small one.
- The workspace path is printed raw across the whole width.
- Letter-spaced capital labels (WORKSPACE, PROJECT, HOME) are on every
  surface. They add noise rather than hierarchy, and the status bar
  repeats the sidebar's view name.
- Settings puts each control in a column 900px from its label, and shows
  a raw settings path.
- The Run view is a flat list. A command, its status and its output have
  no structure, and the prompt label ("OXIS ❯") reads like output.
- Toasts appear bottom-centre, over content and the prompt.

**Components**
- Every control is hand-rolled in place: buttons, tabs, nav items, window
  controls, splitter handles. Each has its own size, hover colour and
  padding. `button()`, `panel()` and `setting_row()` cover a fraction of
  the cases.
- Icons are drawn line by line with mixed sizes and stroke weights.
- Inputs are ImGui frames with only their colours changed. Nothing shows
  focus, and heights are inconsistent (28–38px).

**Navigation**
- The rail shows icons only, with no labels and no shortcuts.
- Nothing tells the user what exists but isn't built yet (the editor,
  plugins, language tooling).

**Behaviour that stays**
- Window dragging and resizing, maximise and restore, workspace
  switching, the drive harness and every engine feature already work.
  The redesign keeps all of them and their tests.

## Design system

**Identity.** The folded-ribbon O (drawn from `assets/logo.svg`) and the
green accent family stay, on the existing dark, slightly cool surfaces.
Green marks what's active, primary or successful, and nothing else.

**Surfaces** (darkest to lightest). Each is a separate kind of thing, not
decoration:

| Token | Use |
|---|---|
| `chrome` | Title bar, activity rail, status bar. |
| `base` | Content views and terminals. |
| `raised` | Panels inside a view, inputs, tab strips. |
| `overlay` | Menus, tooltips, toasts. |
| `line` / `line_strong` | Hairline separators and control borders, used sparingly. |

**Text.** Primary, secondary, tertiary and disabled. Error, warning and
info are kept for status.

**Type.** IBM Plex Sans for the interface:
- 13px body, 12px meta;
- 15px semibold section titles;
- 20px semibold page titles;
- 11px capitals with light tracking, only for group labels in menus and
  lists.

JetBrains Mono is for code, paths, commands and terminals. System fonts
are merged behind both for symbols and other scripts.

**Spacing.** A 4px grid: 4, 8, 12, 16, 24, 32. Controls are 28px high
(32px for primary actions). Radii are 4px on controls and 6px on
overlays. There are no rounded cards: sections are separated by space and
hairlines.

**Icons.** One set on a 16px grid, with 1.5px strokes, round caps and
optical centring, drawn as vectors so they're sharp at any display scale.

**States.** Every control has the same states:
- hover: a +4% surface;
- pressed: +8%;
- focus: a green ring on keyboard focus;
- disabled: 40% opacity and no hover.

Hit targets are at least 28×28.

## Plan

Each stage is previewed before it's committed.

1. **System and shell**
   - Tokens, type scale and the icon set.
   - One widget module: buttons (primary, secondary, ghost, danger), icon
     buttons, text inputs with focus rings, a toggle, a select, tooltips
     with shortcuts, section headers and list rows.
   - ImGui styled fully, so no default blue is left anywhere.
   - The title bar: the real logo, the workspace switcher, the current
     view, and window controls with correct hit targets at any scale.
   - The activity rail: labels in tooltips, Ctrl+1/2/3 and Ctrl+, as
     shortcuts, and the editor, plugins and language tools shown as "in
     development" without being clickable.
   - A status bar with useful facts: workspace, Git remote, running
     commands, shell, version.
   - Toasts placed out of the way.
2. **Views**
   - Home as a workspace manager: a list with each workspace's folder,
     remote, terminals and running commands; the selected workspace's
     details editable in place; no fixed-height boxes; no scrolling at
     the minimum size.
   - The Run view as structured command blocks: status, duration and exit
     code in the header; collapsible output; a clear prompt.
   - Settings grouped (Terminal, Workspace, Startup), with labels and
     controls side by side, and the font size exposed.
   - The terminal's tab strip and empty state in the new components.
3. **Verification**
   - Drive snapshots at 720×460, 1366×768, 1920×1080 and 150% scale.
   - The existing end-to-end tests updated to the new hotspots, plus
     tests for the new interactions (shortcuts, the in-development items
     doing nothing).
