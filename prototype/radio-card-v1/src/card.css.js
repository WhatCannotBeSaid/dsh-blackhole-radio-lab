/**
 * Single source of appearance for the radio card.
 *
 * The plugin bundle and the preview both import this string and inject it as
 * one <style> element, so there is exactly one stylesheet to review — the two
 * entry points differ only in what mounts the card and what feeds it state.
 *
 * Nothing here selects host classes or reaches outside `.rc-*`, so the sheet is
 * safe to load alongside the existing sidebar and other plugins.
 *
 * Theme:
 *   Colours come from the host's public semantic tokens (`--dsw-alias-*`,
 *   `--dsw-elevation-panel`, `--dsw-focus-ring-*`). Those tokens are declared by
 *   @deepseek-ai/dsh-client-ui-theme on <body> and flip with the user's DSH theme
 *   (light / dark / system), so the card follows an explicit DSH choice instead
 *   of the OS media query. The only non-token switch is the art layer below: it
 *   keys off `body[data-ds-dark-theme]`, the marker that same package documents
 *   and sets on <body>. Every token use carries a literal fallback so the sheet
 *   still renders when it is loaded outside DSH (the standalone preview, tests).
 *
 * Layout modes (this round's prototype contract):
 *   full        — two text lines + full control row. The black hole is a
 *                 background layer, not a column, so text keeps the width.
 *   compact     — one line (station + favourite) + control row; song/artist move
 *                 into the "more" popover.
 *   compact-min — narrowest: station only, with favourite/like/song moved into
 *                 the "more" popover so no function disappears.
 */

export const CARD_STYLE_ID = 'radio-card-prototype-styles';

export const CARD_CSS = `
.rc-card {
  /* host tokens (public, theme-aware) with standalone fallbacks */
  --rc-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --rc-surface-raised: var(--dsw-alias-bg-layer-2, #ffffff);
  --rc-ink: var(--dsw-alias-label-primary, #0f1115);
  --rc-dim: var(--dsw-alias-label-secondary, #61666b);
  --rc-line: var(--dsw-alias-border-l2, rgba(15, 17, 21, 0.10));
  --rc-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06));
  --rc-accent: var(--dsw-alias-state-business-primary, #4176e6);
  --rc-focus: var(--dsw-focus-ring-color, var(--rc-accent));
  --rc-shadow: var(--dsw-elevation-panel,
    0 0 0 0.5px rgba(0, 0, 0, 0.16), 0 3px 8px rgba(0, 0, 0, 0.03),
    0 0 16px rgba(0, 0, 0, 0.02));

  /* state colours: saturated enough to read on both surfaces */
  --rc-fav: #b7791f;
  --rc-like: #d6446a;

  /* art layer: light card, dark hole core, warm ring */
  --rc-scrim: 247 249 253;
  --rc-card-bg: linear-gradient(135deg, #f8fafd 0%, #eef2fa 52%, #e6ebf6 100%);
  --rc-disc-core: #0a0d16;
  --rc-disc-warm: rgba(255, 168, 104, 0.62);
  --rc-disc-violet: rgba(104, 82, 176, 0.50);
  --rc-ring: rgba(126, 104, 196, 0.32);
  --rc-glow: rgba(255, 170, 110, 0.22);
  --rc-disc-blur: 1.5px;
  --rc-disc-opacity: 0.95;

  position: relative;
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--rc-line);
  border-radius: 12px;
  background: var(--rc-card-bg);
  color: var(--rc-ink);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.3;
  text-align: left;
  isolation: isolate;
  overflow: hidden;
}

/* Dark option inside DSH: same layout, host-dark surface, deeper space and
   brighter accents so the card sits in the dark rail instead of glowing. */
body[data-ds-dark-theme] .rc-card {
  --rc-fav: #f2c866;
  --rc-like: #ff97ab;
  --rc-scrim: 13 15 22;
  --rc-card-bg: linear-gradient(135deg, #0d0f17 0%, #0a0c13 60%, #080a10 100%);
  --rc-disc-core: #05060b;
  --rc-disc-warm: rgba(255, 176, 116, 0.58);
  --rc-disc-violet: rgba(112, 88, 190, 0.42);
  --rc-ring: rgba(255, 196, 140, 0.20);
  --rc-glow: rgba(255, 170, 110, 0.10);
  --rc-disc-blur: 3px;
  --rc-disc-opacity: 0.55;
}

.rc-card *,
.rc-card *::before,
.rc-card *::after { box-sizing: border-box; }

/* ── background: the black hole placeholder, behind the text ─────────────── */
.rc-bg {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;   /* never steals input from the foreground controls */
  overflow: hidden;
  border-radius: inherit;
}
/* A small black hole cropped by the right edge, vertically between the track
   line and the volume button: the event horizon is a compact dark core, the
   accretion disc is a thin bright ellipse. Cropping keeps it reading as an
   object passing behind the card rather than a smudge. */
.rc-bg__disc {
  position: absolute;
  right: -10px;
  top: 22px;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background:
    radial-gradient(circle at 46% 42%,
      var(--rc-disc-core) 0 34%,
      var(--rc-disc-warm) 50%,
      var(--rc-disc-violet) 64%,
      transparent 84%);
  filter: blur(var(--rc-disc-blur));
  opacity: var(--rc-disc-opacity);
  animation: rc-orbit 44s linear infinite;
  transform-origin: 50% 50%;
}
.rc-bg__ring {
  position: absolute;
  right: -20px;
  top: 34px;
  width: 98px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--rc-ring);
  box-shadow: 0 0 14px var(--rc-glow) inset;
  transform: rotate(-14deg);
  opacity: 0.9;
}
/* Two scrims: a horizontal one keeps the text column readable, a vertical one
   keeps the control row legible where the disc is closest. Both are derived
   from the theme scrim colour, so the same sheet works on light and dark. */
.rc-bg__veil {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(100deg,
      rgb(var(--rc-scrim) / 0.97) 0%,
      rgb(var(--rc-scrim) / 0.92) 48%,
      rgb(var(--rc-scrim) / 0.58) 74%,
      rgb(var(--rc-scrim) / 0.20) 100%),
    linear-gradient(0deg,
      rgb(var(--rc-scrim) / 0.45) 0%,
      rgb(var(--rc-scrim) / 0.12) 38%,
      transparent 64%);
}
.rc-card[data-anim="off"] .rc-bg__disc { animation-play-state: paused; }

.rc-fg {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

/* ── text lines ──────────────────────────────────────────────────────────── */
.rc-line {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.rc-line--station .rc-entry { font-weight: 600; letter-spacing: 0.01em; }
.rc-line--track .rc-entry { color: var(--rc-dim); font-size: 11.5px; }

.rc-entry {
  position: relative;
  /* Shrink-to-fit, not fill-the-line: the star/heart must follow the text
     instead of being pushed to the far end of the card. */
  flex: 0 1 auto;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 1px 2px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rc-entry:hover { background: var(--rc-hover); }
.rc-entry:focus-visible { outline: 2px solid var(--rc-focus); outline-offset: 1px; }

.rc-ellipsis {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

/* Full text on hover or keyboard focus, without widening the card.
   Positioned by script (position: fixed) so a scrolling card area cannot clip
   it — the tip must stay readable even when the card sits at the area's edge. */
.rc-tip {
  position: fixed;
  left: 0;
  top: 0;
  z-index: 60;
  display: none;
  max-width: min(320px, 80vw);
  width: max-content;
  padding: 5px 7px;
  border: 1px solid var(--rc-line);
  border-radius: 7px;
  background: var(--rc-surface-raised);
  color: var(--rc-ink);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.4;
  white-space: normal;
  overflow-wrap: anywhere;
  box-shadow: var(--rc-shadow);
}
.rc-tip[data-open="true"] { display: block; }

.rc-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--rc-dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}
.rc-icon:hover { background: var(--rc-hover); color: var(--rc-ink); }
.rc-icon:focus-visible { outline: 2px solid var(--rc-focus); outline-offset: 1px; }
.rc-icon[aria-pressed="true"] { color: var(--rc-fav); }
.rc-icon--like[aria-pressed="true"] { color: var(--rc-like); }

/* ── controls ────────────────────────────────────────────────────────────── */
.rc-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  width: 100%;
}
.rc-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-width: 26px;
  margin: 0;
  padding: 0 5px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--rc-dim);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.rc-btn:hover { background: var(--rc-hover); color: var(--rc-ink); }
.rc-btn:focus-visible { outline: 2px solid var(--rc-focus); outline-offset: 1px; }
.rc-btn--play {
  min-width: 30px;
  background: color-mix(in srgb, var(--rc-accent) 16%, transparent);
  border-color: color-mix(in srgb, var(--rc-accent) 34%, transparent);
  color: var(--rc-ink);
}
.rc-btn--play:hover { background: color-mix(in srgb, var(--rc-accent) 26%, transparent); }
.rc-card[data-playing="true"] .rc-btn--play { color: var(--rc-accent); }

.rc-volume-area {
  display: flex;
  /* row-reverse keeps the slider visually left of the speaker, so it expands
     INTO the card, and the whole area parks at the right edge of the row. */
  flex-direction: row-reverse;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  min-width: 0;
}
.rc-volume {
  display: flex;
  align-items: center;
  width: 0;
  min-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: width 160ms ease, opacity 160ms ease;
}
.rc-controls[data-volume-open="true"] .rc-volume {
  /* The box never shrinks below its track's usable minimum, and the track is
     100% OF THE BOX — a fixed-width track inside a shrinking box is exactly how
     the slider used to lose its right end. */
  flex: 0 1 auto;
  width: 92px;
  min-width: 56px;
  opacity: 1;
}
.rc-volume input {
  width: 100%;
  min-width: 0;
  height: 16px;
  margin: 0;
  padding: 0;
  accent-color: var(--rc-accent);
  cursor: pointer;
}
.rc-volume input:focus-visible { outline: 2px solid var(--rc-focus); outline-offset: 2px; }

/* ── compact modes ───────────────────────────────────────────────────────── */
.rc-card[data-mode="compact"] { padding: 8px 9px; }
.rc-card[data-mode="compact"] .rc-fg { gap: 4px; }
.rc-card[data-mode="compact"] .rc-line--track { display: none; }
.rc-card[data-mode="compact"] .rc-btn { height: 24px; min-width: 24px; }
.rc-card[data-mode="compact"] .rc-btn--play { min-width: 28px; }
.rc-card[data-mode="compact"] .rc-controls[data-volume-open="true"] .rc-volume { width: 76px; }

.rc-card[data-mode="compact-min"] { padding: 8px 8px; }
.rc-card[data-mode="compact-min"] .rc-fg { gap: 3px; }
.rc-card[data-mode="compact-min"] .rc-line--track { display: none; }
.rc-card[data-mode="compact-min"] .rc-btn { height: 24px; min-width: 22px; padding: 0 3px; }
.rc-card[data-mode="compact-min"] .rc-btn--play { min-width: 26px; }
.rc-card[data-mode="compact-min"] .rc-controls { gap: 0; }
.rc-card[data-mode="compact-min"] .rc-volume-area { gap: 2px; }
.rc-card[data-mode="compact-min"] .rc-controls[data-volume-open="true"] .rc-volume { width: 64px; min-width: 48px; }

/* The occupant root is the only node the host lays out. It must shrink with
   the rail and never claim a fixed width. */
.rc-occupant {
  display: block;
  flex: 1 1 100%;
  min-width: 0;
  width: 100%;
}

@keyframes rc-orbit { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .rc-bg__disc { animation: none; }
  .rc-volume { transition: none; }
}
`;
