---
'@reqray/dashboard': minor
---

The redesign's palette and type, as tokens

The panel now wears the redesign handoff's palette: cool dark surfaces under
warm paper-toned text, a warm light theme, and every accent in up to four
voices — text, border, pale fill, and data bar — so a tag, a link and a
chart can each speak at their own volume. In dark, tags keep border and text
and lose their fill, while data bars keep their light-theme hues, so the
scanning cue survives the theme switch.

One family now: JetBrains Mono everywhere, on the handoff's scale — 13px
titles, 12.5px table rows, 12px body, 11px chips and buttons, 10px column
heads and section labels. The primary button sits on the deep blue with
light text in both themes. Radii settle at 3px for controls and 2px for
tags; the floating popovers separate by a strong border instead of a drop
shadow, leaving functional insets as the panel's only shadows.

All of it is design tokens and a font link — no component changed behaviour.
