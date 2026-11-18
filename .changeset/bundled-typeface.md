---
'@reqray/dashboard': patch
---

The panel no longer asks another origin for anything. Its typeface, JetBrains
Mono, was loaded from Google Fonts, so a browser with the panel open told a
third party that it was open. The font is now served from the package, with
its licence beside it; the panel looks the same and works offline.
