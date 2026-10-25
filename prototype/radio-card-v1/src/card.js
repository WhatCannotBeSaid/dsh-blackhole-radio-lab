/**
 * The radio card itself, framework-free.
 *
 * The plugin mounts this through a small React host (src/plugin.js), and the
 * isolated preview mounts it directly. Because the DOM, the stylesheet and the
 * state model are shared, "preview look" and "plugin look" cannot drift.
 *
 * Deliberate limits of this prototype:
 *   - no audio element, no fetching, no exploration page — controls only change
 *     the demo model;
 *   - the black hole is a CSS background layer (the phase-02 renderer is NOT
 *     wired in), so no imaging or dynamic-preview performance claim is made;
 *   - the card never reaches outside its own subtree or its own `.rc-*` rules.
 *
 * Layout mode is chosen from the width THIS card actually receives, measured by
 * a ResizeObserver on the card element — never from the rail's nominal width and
 * never from how many plugins are mounted.
 */

import { CARD_CSS, CARD_STYLE_ID } from './card.css.js';

export function ensureCardStyles(doc = document) {
  if (doc.getElementById(CARD_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = CARD_STYLE_ID;
  style.textContent = CARD_CSS;
  doc.head.appendChild(style);
}

/**
 * Prototype layout parameters, measured against the card's own content needs.
 * NOT a design final: they are here to be tuned after real-host review.
 *
 *   full        needs room for two text lines with trailing star/heart.
 *   compact     one text line + control row (prev/play/next/volume).
 *   compact-min station line + control row + "more"; star/heart/song move into
 *               "more", so nothing is lost, only relocated.
 */
export const LAYOUT = Object.freeze({
  FULL_MIN: 232,
  COMPACT_MIN: 176,
  HYSTERESIS: 6,
});

const MODES = ['full', 'compact', 'compact-min'];

/** Hysteresis ladder: a mode is only left after crossing its threshold by 6px. */
function nextMode(width, current) {
  const { FULL_MIN, COMPACT_MIN, HYSTERESIS: H } = LAYOUT;
  if (current === 'full') {
    if (width >= FULL_MIN - H) return 'full';
    return width >= COMPACT_MIN - H ? 'compact' : 'compact-min';
  }
  if (current === 'compact') {
    if (width < COMPACT_MIN - H) return 'compact-min';
    return width >= FULL_MIN + H ? 'full' : 'compact';
  }
  if (width < COMPACT_MIN + H) return 'compact-min';
  return width >= FULL_MIN + H ? 'full' : 'compact';
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Inline speaker glyph: a bare "♪" reads as a note, not as volume. */
function speakerGlyph(doc) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const body = doc.createElementNS(ns, 'path');
  body.setAttribute('d', 'M3 6.2h2.2L8.4 3.4v9.2L5.2 9.8H3z');
  body.setAttribute('fill', 'currentColor');
  const wave1 = doc.createElementNS(ns, 'path');
  wave1.setAttribute('d', 'M10.2 5.6a3.4 3.4 0 0 1 0 4.8');
  wave1.setAttribute('fill', 'none');
  wave1.setAttribute('stroke', 'currentColor');
  wave1.setAttribute('stroke-width', '1.4');
  wave1.setAttribute('stroke-linecap', 'round');
  const wave2 = doc.createElementNS(ns, 'path');
  wave2.setAttribute('d', 'M12.2 3.6a6.2 6.2 0 0 1 0 8.8');
  wave2.setAttribute('fill', 'none');
  wave2.setAttribute('stroke', 'currentColor');
  wave2.setAttribute('stroke-width', '1.4');
  wave2.setAttribute('stroke-linecap', 'round');
  svg.append(body, wave1, wave2);
  return svg;
}

function entryLine(doc, lineClass, textClass) {
  const line = el(doc, 'div', `rc-line ${lineClass}`);
  const entry = el(doc, 'button', 'rc-entry');
  entry.type = 'button';
  // Non-control area: records intent only. Never opens anything this round.
  const text = el(doc, 'span', `rc-ellipsis ${textClass}`);
  const tip = el(doc, 'span', 'rc-tip');
  // The visual tip repeats the button's accessible name; hide it from the
  // accessibility tree so the name is not announced twice.
  tip.setAttribute('aria-hidden', 'true');
  entry.append(text, tip);
  line.append(entry);
  return { line, entry, text, tip };
}

/**
 * @param {{
 *   model: ReturnType<typeof import('./model.js').createDemoModel>,
 *   onEntry?: (source: string) => void,
 *   doc?: Document,
 * }} options
 */
export function createCard({ model, onEntry, doc = document }) {
  ensureCardStyles(doc);
  const view = doc.defaultView;

  const card = el(doc, 'article', 'rc-card');
  card.setAttribute('aria-label', '电台播放卡片');
  card.dataset.mode = 'full';
  card.dataset.anim = 'on';

  // ── background layer: decorative only, never hit-testable ─────────────────
  const bg = el(doc, 'div', 'rc-bg');
  bg.setAttribute('aria-hidden', 'true');
  bg.append(el(doc, 'div', 'rc-bg__disc'), el(doc, 'div', 'rc-bg__ring'), el(doc, 'div', 'rc-bg__veil'));

  // ── foreground ────────────────────────────────────────────────────────────
  const fg = el(doc, 'div', 'rc-fg');

  const station = entryLine(doc, 'rc-line--station', 'rc-station');
  const fav = el(doc, 'button', 'rc-icon rc-icon--fav', '★');
  fav.type = 'button';
  fav.setAttribute('aria-label', '收藏电台');

  station.line.append(fav);

  const track = entryLine(doc, 'rc-line--track', 'rc-track');
  const like = el(doc, 'button', 'rc-icon rc-icon--like', '♥');
  like.type = 'button';
  like.setAttribute('aria-label', '喜爱当前歌曲');
  track.line.append(like);

  const controls = el(doc, 'div', 'rc-controls');
  const prev = el(doc, 'button', 'rc-btn', '⏮');
  prev.type = 'button';
  prev.setAttribute('aria-label', '上一台');
  const play = el(doc, 'button', 'rc-btn rc-btn--play', '▶');
  play.type = 'button';
  play.setAttribute('aria-label', '播放');
  const next = el(doc, 'button', 'rc-btn', '⏭');
  next.type = 'button';
  next.setAttribute('aria-label', '下一台');

  const volumeButton = el(doc, 'button', 'rc-btn rc-btn--volume');
  volumeButton.type = 'button';
  volumeButton.setAttribute('aria-label', '音量');
  volumeButton.setAttribute('aria-expanded', 'false');
  volumeButton.append(speakerGlyph(doc));

  const volume = el(doc, 'div', 'rc-volume');
  const slider = el(doc, 'input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.setAttribute('aria-label', '音量');
  // Out of the tab order while collapsed: a focused, clipped slider would be
  // reachable but unusable.
  slider.tabIndex = -1;
  volume.append(slider);

  // The button and the slider form one hover/focus region, so moving from the
  // button to the slider never counts as leaving.
  const volumeArea = el(doc, 'div', 'rc-volume-area');
  volumeArea.append(volumeButton, volume);

  controls.append(prev, play, next, volumeArea);
  fg.append(station.line, track.line, controls);

  card.append(bg, fg);

  // ── events ─────────────────────────────────────────────────────────────────
  const emitEntry = (source) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    onEntry?.(source);
  };

  station.entry.addEventListener('click', emitEntry('station-line'));
  track.entry.addEventListener('click', emitEntry('track-line'));

  // Empty card space behaves like the future scene entry; controls never do.
  // The background layer is pointer-events:none, so its clicks land here.
  card.addEventListener('click', (event) => {
    if (event.target.closest('button, input, .rc-controls')) return;
    onEntry?.('card-body');
  });

  prev.addEventListener('click', () => model.prev());
  next.addEventListener('click', () => model.next());
  play.addEventListener('click', () => model.togglePlay());
  fav.addEventListener('click', () => model.toggleFavourite());
  like.addEventListener('click', () => model.toggleLike());

  // ── volume ─────────────────────────────────────────────────────────────────
  // Hover/focus open the slider; this remembers when, so a click that arrives
  // right after a hover-open is read as "keep it open" instead of "close it".
  let closeTimer = 0;
  let openedAt = 0;
  const isOpen = () => model.getState().volumeOpen;
  const openVolume = () => {
    clearTimeout(closeTimer);
    if (!isOpen()) {
      openedAt = Date.now();
      model.setVolumeOpen(true);
    }
  };
  const closeVolume = ({ restoreFocus = false } = {}) => {
    clearTimeout(closeTimer);
    if (!isOpen()) return;
    if (restoreFocus && volumeArea.contains(doc.activeElement)) volumeButton.focus();
    model.setVolumeOpen(false);
    slider.tabIndex = -1;
  };
  // Leaving with the pointer closes after a grace period — unless a KEYBOARD user
  // is inside the area (visible focus ring), in which case it stays open for them.
  // A mouse-driven focus on the slider must not pin the slider open forever, so
  // it is handed back to the speaker button before collapsing.
  const onPointerLeave = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (!isOpen()) return;
      const active = doc.activeElement;
      if (active && volumeArea.contains(active)) {
        if (active.matches(':focus-visible')) return;
        volumeButton.focus({ preventScroll: true });
      }
      closeVolume();
    }, 220);
  };
  // Moving focus between the speaker and the slider stays inside; moving out of
  // the area collapses immediately, so focus can never be left on a hidden slider.
  const onFocusOut = (event) => {
    const to = event.relatedTarget;
    if (to && volumeArea.contains(to)) return;
    closeVolume();
  };

  volumeArea.addEventListener('pointerenter', openVolume);
  volumeArea.addEventListener('pointerleave', onPointerLeave);
  volumeArea.addEventListener('focusin', openVolume);
  volumeArea.addEventListener('focusout', onFocusOut);
  volumeButton.addEventListener('click', () => {
    if (isOpen() && Date.now() - openedAt > 300) closeVolume();
    else openVolume();
  });
  volumeArea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      event.stopPropagation();
      closeVolume({ restoreFocus: true });
    }
  });
  slider.addEventListener('input', () => model.setVolume(Number(slider.value) / 100));

  // ── full-text tip ──────────────────────────────────────────────────────────
  // Positioned with position: fixed, because the card lives inside a scrolling
  // card area: an absolutely positioned tip would be clipped at the area edge.
  let openContext = null;
  const hideTip = () => {
    if (!openContext) return;
    openContext.tip.dataset.open = 'false';
    openContext = null;
  };
  // Re-placing on scroll/resize matters: focusing a clipped line scrolls the
  // card area, and hiding on that first scroll would swallow the very tip the
  // keyboard user just asked for.
  const placeTip = (context) => {
    const { entry, tip, text } = context;
    if (!entry.isConnected || text.scrollWidth <= text.clientWidth + 1) {
      hideTip();
      return;
    }
    const anchor = entry.getBoundingClientRect();
    if (anchor.bottom < 0 || anchor.top > view.innerHeight) {
      hideTip();
      return;
    }
    tip.dataset.open = 'true';
    // Keep the tip inside the card's own column: the sidebar clips its column,
    // and a tip wider than the card would look like it belonged to the page.
    const cardWidth = card.getBoundingClientRect().width;
    tip.style.maxWidth = `${Math.round(Math.min(320, Math.max(160, cardWidth)))}px`;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const size = tip.getBoundingClientRect();
    const x = Math.max(6, Math.min(anchor.left, view.innerWidth - size.width - 6));
    let y = anchor.bottom + 6;
    if (y + size.height > view.innerHeight - 6) y = Math.max(6, anchor.top - size.height - 6);
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
    openContext = context;
  };
  const showTip = (context) => {
    hideTip();
    placeTip(context);
  };
  const refreshOverlays = () => {
    if (openContext) placeTip(openContext);
  };
  // A visual tip is only attached while a line is actually clipped; the button
  // keeps the full text as its accessible name either way.
  const bindTip = (context) => {
    const { entry } = context;
    entry.addEventListener('pointerenter', () => showTip(context));
    entry.addEventListener('pointerleave', hideTip);
    entry.addEventListener('focus', () => showTip(context));
    entry.addEventListener('blur', hideTip);
  };
  bindTip(station);
  bindTip(track);
  view.addEventListener('scroll', refreshOverlays, true);
  view.addEventListener('resize', refreshOverlays);

  // ── background animation: only while the card is visible ──────────────────
  const setAnim = () => {
    const visible = !doc.hidden && card.isConnected;
    card.dataset.anim = visible ? 'on' : 'off';
  };
  const onVisibility = () => setAnim();
  doc.addEventListener('visibilitychange', onVisibility);
  let io = null;
  if (typeof view.IntersectionObserver === 'function') {
    io = new view.IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        card.dataset.anim = entry && entry.isIntersecting && !doc.hidden ? 'on' : 'off';
      },
      { threshold: 0 },
    );
    io.observe(card);
  }

  // ── layout mode from the width this card actually gets ────────────────────
  let mode = 'full';
  const applyMode = (width) => {
    const wanted = nextMode(width, mode);
    if (wanted === mode) return;
    mode = wanted;
    card.dataset.mode = mode;
    // If focus was inside something the new mode hides, move it somewhere
    // visible instead of leaving focus on a display:none node.
    const active = doc.activeElement;
    if (active && card.contains(active)) {
      const hiddenNow = mode !== 'full' && track.entry.contains(active);
      if (hiddenNow) station.entry.focus({ preventScroll: true });
    }
    refreshOverlays();
  };
  let ro = null;
  if (typeof view.ResizeObserver === 'function') {
    ro = new view.ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      // border-box, not content-box: LAYOUT thresholds describe the width the
      // card occupies in the rail (the same number getBoundingClientRect
      // reports). Using contentRect here silently subtracted padding+border and
      // made every mode fire ~22px early.
      const box = entry.borderBoxSize;
      const width = box
        ? (Array.isArray(box) ? box[0].inlineSize : box.inlineSize)
        : entry.contentRect.width + (card.offsetWidth - entry.contentRect.width);
      applyMode(width);
    });
    ro.observe(card);
  }
  // Initial pass: ResizeObserver fires once on observe, but a synchronous read
  // keeps the first paint from flashing the full layout in a narrow slot.
  applyMode(card.getBoundingClientRect().width || LAYOUT.FULL_MIN);

  // ── render ─────────────────────────────────────────────────────────────────
  const render = (state) => {
    const { station: current, favourite, liked, playing, volumeOpen, volume: level } = state;
    card.dataset.playing = String(playing);

    station.text.textContent = current.name;
    station.tip.textContent = current.name;
    station.entry.setAttribute('aria-label', current.name);

    const trackText = `${current.song} · ${current.artist}`;
    track.text.textContent = trackText;
    track.tip.textContent = trackText;
    track.entry.setAttribute('aria-label', trackText);

    fav.setAttribute('aria-pressed', String(favourite));
    like.setAttribute('aria-pressed', String(liked));

    play.textContent = playing ? '⏸' : '▶';
    play.setAttribute('aria-label', playing ? '暂停' : '播放');

    controls.dataset.volumeOpen = String(volumeOpen);
    volumeButton.setAttribute('aria-expanded', String(volumeOpen));
    slider.tabIndex = volumeOpen ? 0 : -1;
    if (doc.activeElement !== slider) slider.value = String(Math.round(level * 100));
  };

  render(model.getState());
  const unsubscribe = model.subscribe(render);

  return {
    el: card,
    mode: () => mode,
    destroy() {
      clearTimeout(closeTimer);
      hideTip();
      // Collapse the slider before the subtree disappears; a focused node that
      // is removed would otherwise leave focus on <body> with no context.
      if (isOpen()) closeVolume();
      const active = doc.activeElement;
      if (active && card.contains(active)) {
        const toggle = doc.querySelector('button[aria-label="打开侧边栏"], button[aria-label="收起侧边栏"]');
        if (toggle && typeof toggle.focus === 'function') toggle.focus({ preventScroll: true });
        else if (typeof active.blur === 'function') active.blur();
      }
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      doc.removeEventListener('visibilitychange', onVisibility);
      view.removeEventListener('scroll', refreshOverlays, true);
      view.removeEventListener('resize', refreshOverlays);
      unsubscribe();
      card.remove();
    },
  };
}

/** Convenience wrapper used by the preview and the (unwired) plugin host. */
export function mountCard(container, options) {
  const card = createCard(options);
  container.append(card.el);
  return card;
}
