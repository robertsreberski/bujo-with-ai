# SPEC-05 — PWA & iOS Standalone

Governs: web app manifest, service worker, offline behavior, and iOS
standalone-mode hardening. Requirement IDs: `PWA-*`. The iOS section encodes
hard-won platform behavior — treat it as normative, not advisory.

## 1. Manifest & install

- PWA-1 `manifest.webmanifest`:

  ```json
  {
    "name": "Journal",
    "short_name": "Journal",
    "start_url": "/",
    "scope": "/",
    "display": "standalone",
    "orientation": "portrait",
    "background_color": "#16130F",
    "theme_color": "#16130F",
    "icons": [
      { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
      { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
      {
        "src": "/icons/maskable-512.png",
        "sizes": "512x512",
        "type": "image/png",
        "purpose": "maskable"
      }
    ]
  }
  ```

- PWA-2 `apple-touch-icon` (180px, opaque `#16130F` background) — iOS
  ignores manifest icons for the home screen.
- PWA-3 Required meta tags (all four; each gates a specific behavior):

  ```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  ```

  `viewport-fit=cover` is what makes `env(safe-area-inset-*)` non-zero;
  `black-translucent` overlays the status bar, so the app paints its own
  background behind the notch.

- PWA-4 Install context: service workers require a secure context. On the
  tailnet this is satisfied by Tailscale Serve's HTTPS (ARC-7); `localhost`
  works for development. Plain `http://<tailscale-ip>` will never install —
  not a supported path.

## 2. Service worker & offline

- PWA-5 A custom Workbox `injectManifest` service worker precaches the Vite
  build manifest (shell, fonts, icons). Navigations use an app-shell fallback
  so any route loads offline. A new worker remains waiting; it calls
  `skipWaiting` only after the owner selects **Reload** (PWA-8), then claims
  clients after activation.
- PWA-6 Runtime strategies:

  | Request                                                                     | Strategy                                                                                                                                  |
  | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /api/entries*`, `/api/collections*`, `/api/activity*`, `/api/summary*` | network-first, 3s timeout, cache fallback; IndexedDB remains the canonical client mirror                                                  |
  | `GET /api/events` (SSE)                                                     | never intercepted                                                                                                                         |
  | mutations (`POST/PATCH/DELETE`)                                             | never cached — handled by the outbox (SPEC-07), **not** Workbox Background Sync (iOS support is unreliable; the outbox lives in app code) |
  | static assets                                                               | cache-first (precache)                                                                                                                    |

- PWA-7 Offline UX: reads and drafts come from the IndexedDB store mirror
  (SPEC-07 §4); deterministic entry and collection commands queue silently.
  Token operations, settings that require server truth, summary actions, and
  activity revert require an online connection. A thin "Offline — changes will sync"
  pill shows under the header while unreachable; no blocking states.
- PWA-8 Update flow: on SW update, show a quiet "Update ready — Reload"
  affordance in settings. Selecting it first persists the current draft/store,
  messages the waiting worker to activate, and reloads on `controllerchange`;
  never auto-reload mid-session.

## 3. CSS foundation (iOS-safe)

- PWA-9 Safe-area variables and white-bar fix, verbatim:

  ```css
  :root {
    --sat: env(safe-area-inset-top, 0px);
    --sab: env(safe-area-inset-bottom, 0px);
    --sal: env(safe-area-inset-left, 0px);
    --sar: env(safe-area-inset-right, 0px);
  }
  html {
    height: 100%;
    min-height: calc(100% + env(safe-area-inset-top, 0px)); /* prevents white bar */
    overflow: hidden;
    background-color: var(--bg-page); /* separate property — the `background`
                                         shorthand resets color and causes
                                         notch-region gaps */
  }
  body {
    height: var(--app-height, 100vh);
    overflow: hidden;
    overscroll-behavior: none;
    touch-action: manipulation;
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
  }
  input,
  select,
  textarea {
    font-size: 16px;
  } /* iOS zoom prevention (DS-6) */
  .scrollable {
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior-y: contain;
  }
  ```

- PWA-10 **Never `100vh`.** All full-height sizing uses
  `var(--app-height, 100vh)`, set from `window.innerHeight` by JS (guarding
  against the stale `0` iOS returns on first resume). The prototype's
  `height: 100vh` frame maps to `--app-height`.
- PWA-11 **Safe-area single-level rule.** Each inset is applied at exactly
  one level per subtree: `--sat` as a dedicated status-bar spacer flex child
  above the header (not padding inside the scroll container); `--sab` on the
  composer container only — no child re-adds it. Left/right insets on the
  frame in landscape.
- PWA-12 No `-webkit-overflow-scrolling: touch` anywhere (legacy; interferes
  with `overscroll-behavior` on iOS 15+). The main scroll container keeps
  `overscroll-behavior-y: contain` (already in the prototype).

## 4. Keyboard & composer docking

The bottom-docked composer is the app's core interaction; iOS standalone mode
does **not** resize the layout viewport when the keyboard opens — it overlays
it. `visualViewport` is the only truth.

- PWA-13 A viewport-layout hook measures `visualViewport` and maintains:
  `--app-height`, `--vv-height`, `--vv-offset`, and a `keyboard-open` class
  on `<html>`. Keyboard is considered open only when
  (a) the visible-viewport shortfall exceeds 150px **and** (b) the focused
  element is a text-entry target (`input` of text-like type, `textarea`,
  contenteditable). The element check prevents false positives from PiP /
  split view.
- PWA-14 Measurement scheduling: re-measure on `resize`,
  `orientationchange`, `focusin`/`focusout`, `pageshow`,
  `visibilitychange`, and `visualViewport` `resize` — each scheduled at
  delays [0, 120, 360]ms (720ms added on resume) to catch the ~300ms iOS
  keyboard animation. Ignore `visualViewport.scroll` while `keyboard-open`
  (iOS emits tiny offset shifts per keystroke; re-measuring them causes a
  feedback loop that makes the composer jitter).
- PWA-15 `keyboard-open` behavior: tab bar hides; the composer pins to the
  visible viewport bottom (`--vv-offset`/`--vv-height`), sitting flush above
  the keyboard; the day list keeps its scroll position; `--sab` padding is
  dropped while the keyboard covers the home-indicator area. On dismiss,
  force a WebKit flex recalc (read `offsetHeight`) — otherwise flex children
  hold keyboard-open dimensions for a frame.
- PWA-16 Focus scroll: focusing the composer scrolls the newest entries into
  view with `behavior: 'auto'` — `smooth` double-animates against the
  keyboard slide and feels broken.
- PWA-17 The type-menu popover and dialogs opened while the keyboard is up
  position against the _visual_ viewport (`--vv-*`), not the layout
  viewport.

## 5. Touch & scroll behavior

- PWA-18 Every touch target has a measured hit box ≥40px (checkbox padding,
  icon-button wrapper, and a ≥40px calendar button around its 38px visual).
- PWA-19 Popover/menu items use `onPointerDown` + `preventDefault` to avoid
  blurring the composer (iOS fires blur between `touchend` and `mousedown`;
  `onMouseDown` handlers act after the blur has already closed the menu),
  with `onClick` doing the action.
- PWA-20 `window.confirm`/`alert` are banned; destructive confirmations use
  the app's dialog components.
- PWA-21 Scroll containment: `body` `overscroll-behavior: none`; the main
  list and dialog bodies `overscroll-behavior-y: contain`. Because iOS
  ignores `overflow: hidden` for touch gestures at scroll boundaries, the
  dialog overlay installs the boundary-clamping `touchmove` handler (block
  scroll past top/bottom of the inner scrollable; block entirely on
  non-scrollable overlay chrome).
- PWA-22 Padding inside scroll containers is scrollable space — the day
  list's bottom breathing room is margin on the last section, not container
  padding.

## 6. Resume & lifecycle

- PWA-23 On `visibilitychange → visible` / `pageshow` (incl. bfcache):
  re-measure `--app-height` (immediate + 200ms + 720ms), clear stale
  `keyboard-open` state and `--vv-*` vars, establish replayable SSE, flush the
  ordered outbox, then reset/bootstrap or refetch if the stream requires it
  (SPEC-07 §5). iOS suspends PWAs
  aggressively; resume must be cheap and idempotent.
- PWA-24 "Today" rollover: recompute from the last server timezone/context on
  resume and at that timezone's midnight, then confirm with the server when
  online. A day section for the new day appears without reload. Already queued
  offline captures retain their frozen date intent (ARC-16).
- PWA-25 SSE connections die silently when iOS backgrounds the app; the SSE
  client treats `visibilitychange` as a reconnect signal and reconciles via
  cursor replay (SPEC-07 §3) rather than assuming continuity.

## 7. Desktop PWA

- PWA-26 Desktop (Chrome/Edge/Safari) gets the same build; ⌘K, hover states,
  and the wide sidebar layout (DS-10) apply. No desktop-specific code paths
  beyond CSS breakpoints and pointer-hover media queries
  (`@media (hover: hover)` gates hover styles so touch doesn't sticky-hover).

## 8. Acceptance checklist (device QA, per release)

iPhone (standalone, notched device):

1. No white/black bar at top or bottom; status-bar area painted `#16130F`.
2. Composer sits flush above the keyboard while typing; no jitter while
   typing; tab bar restored cleanly on dismiss.
3. No page-level rubber-band; day list bounces within itself only.
4. Focusing the composer does not zoom the page.
5. App-switch away during capture → return: draft intact, layout correct,
   queued entry syncs.
6. Airplane mode: journal readable, capture works, banner shows; disable →
   entries sync, SSE resumes.
7. Home-screen install shows correct icon/name; cold offline launch renders
   the journal.
