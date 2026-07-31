# UI and accessibility review

The first pass found eight actionable defects: focus could escape a dialog;
the month calendar used an incomplete ARIA grid pattern; migration progress was
announced before its mutation settled; 320 px calendar targets could shrink
below 40 px; remote search failure looked like an empty result; actionable
terminal entries still exposed filing; the Search field was 36 px tall; and
several borders/focus rings missed the required contrast. It also found a
double-applied safe-area inset and a DST-unsafe "yesterday" calculation.

All findings were assigned to the UI wave with focused tests. The parent also
expanded axe coverage to every primary view and made every tagged WCAG A/AA
violation release-blocking.
