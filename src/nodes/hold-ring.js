/**
 * The hold ring: the progress circle that appears beside the pointer while a
 * press is being held.
 *
 * It is DOM rather than a WebGL draw because it is a control, not a picture: it
 * has to sit at the pointer in CSS pixels, stay crisp at any device pixel ratio,
 * and cost nothing when it is not on screen. Two SVG circles do all of it — a
 * faint track and the warm arc that fills clockwise from twelve o'clock.
 *
 * The ring is the only feedback before the console locks, so it is also the only
 * thing that tells the user "hold or let go" while nothing moves yet. Once the
 * hold commits, the ring fills, pulses and leaves the screen: from that instant
 * the frame itself is the feedback.
 */

const NS = 'http://www.w3.org/2000/svg';
const RADIUS = 17;
const STROKE = 2.6;
const SIZE = (RADIUS + 8) * 2;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const WARM = 'rgba(255, 178, 96, 0.95)';
const TRACK = 'rgba(255, 232, 208, 0.18)';
const SHADOW = 'rgba(0, 0, 0, 0.42)';

export function createHoldRing(container) {
  const root = document.createElement('div');
  root.setAttribute('data-bhrl-hold-ring', 'true');
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    `width:${SIZE}px`,
    `height:${SIZE}px`,
    'pointer-events:none',
    'z-index:4',
    'opacity:0',
    'transition:opacity 140ms linear',
    'will-change:transform, opacity',
    'display:block',
  ].join(';');

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  svg.setAttribute('viewBox', `0 0 ${SIZE} ${SIZE}`);
  svg.style.cssText = 'display:block;overflow:visible';

  const circle = (radius, stroke, width, opacity) => {
    const node = document.createElementNS(NS, 'circle');
    node.setAttribute('cx', String(CENTER));
    node.setAttribute('cy', String(CENTER));
    node.setAttribute('r', String(radius));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', stroke);
    node.setAttribute('stroke-width', String(width));
    if (opacity !== undefined) node.setAttribute('stroke-opacity', String(opacity));
    return node;
  };

  // A dark backing ring keeps the track readable over the disk's own light.
  const backing = circle(RADIUS, SHADOW, STROKE + 3.4);
  const track = circle(RADIUS, TRACK, STROKE);
  const arc = circle(RADIUS, WARM, STROKE);
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', String(CIRCUMFERENCE));
  arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
  // Fill starts at twelve o'clock and runs clockwise, the same way a clock does;
  // an arc that starts on the right reads as a spinner, not as a countdown.
  arc.setAttribute(
    'transform',
    `rotate(-90 ${CENTER} ${CENTER})`,
  );

  svg.appendChild(backing);
  svg.appendChild(track);
  svg.appendChild(arc);

  // One short echo, fired once a press has been held long enough to count as a
  // hold. It is a second circle so it can expand on its own while the arc keeps
  // filling where it is.
  const echo = circle(RADIUS, WARM, STROKE * 0.8, 0);
  echo.setAttribute('cx', String(CENTER));
  echo.setAttribute('cy', String(CENTER));
  echo.setAttribute('fill', 'none');
  echo.style.cssText = 'opacity:0;transform-origin:' + CENTER + 'px ' + CENTER + 'px';
  svg.appendChild(echo);
  root.appendChild(svg);

  // The panel owns the stacking context, so this element is positioned in its
  // coordinate space and must be found inside it, not against the viewport.
  if (container) container.appendChild(root);

  let progress = 0;
  let visible = false;
  let hiddenTimer = 0;
  let echoTimer = 0;

  const hide = () => {
    if (!visible && progress === 0) return;
    visible = false;
    progress = 0;
    arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
    root.style.transition = 'opacity 140ms linear';
    root.style.opacity = '0';
    root.style.transform = root.style.transform.replace(/scale\([^)]*\)/, 'scale(1)');
  };

  const move = (x, y) => {
    const scale = /scale\([^)]*\)/.exec(root.style.transform);
    const offset = `translate(${Math.round(x - CENTER)}px, ${Math.round(y - CENTER)}px)`;
    root.style.transform = scale ? `${offset} ${scale[0]}` : offset;
  };

  return {
    element: root,
    /** Put the ring at a container-relative pixel position and show it. */
    show(x, y) {
      if (hiddenTimer) {
        clearTimeout(hiddenTimer);
        hiddenTimer = 0;
      }
      move(x, y);
      // Appearance belongs to the first moving frame, not a CSS fade clock.
      root.style.transition = 'none';
      root.style.opacity = '1';
      visible = true;
    },
    /** Move and fill in one step; `p` is 0..1 of the arc. */
    setProgress(p, x, y) {
      const value = Math.max(0, Math.min(1, Number(p) || 0));
      progress = value;
      if (x !== undefined && y !== undefined) move(x, y);
      arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE * (1 - value)));
      if (!visible) {
        visible = true;
        root.style.transition = 'none';
        root.style.opacity = '1';
      }
    },
    /**
     * The hold committed. The arc snaps shut, the ring swells a little and
     * leaves: anything more would compete with the transition starting behind it.
     */
    complete() {
      arc.setAttribute('stroke-dashoffset', '0');
      // A delayed first frame can also be the last. Commit its visible style
      // before fading, or the browser can coalesce show + complete into 0 → 0.
      root.getBoundingClientRect();
      root.style.transition = 'opacity 220ms linear, transform 220ms ease-out';
      root.style.transform = `${root.style.transform} scale(1.22)`;
      root.style.opacity = '0';
      visible = false;
      progress = 0;
      if (hiddenTimer) clearTimeout(hiddenTimer);
      hiddenTimer = setTimeout(() => {
        hiddenTimer = 0;
        root.style.transition = 'opacity 140ms linear';
        root.style.transform = root.style.transform.replace(/scale\([^)]*\)/, 'scale(1)');
        arc.setAttribute('stroke-dashoffset', String(CIRCUMFERENCE));
      }, 240);
    },
    hide,
    /**
     * "This press has been held long enough to count." One outward echo, no
     * timing of its own: the stage decides when, this only draws.
     */
    pulse() {
      if (echoTimer) {
        clearTimeout(echoTimer);
        echoTimer = 0;
      }
      echo.style.transition = 'none';
      echo.style.transform = 'scale(0.72)';
      echo.style.opacity = '0.85';
      // Commit that start frame, or the browser coalesces it with the end and
      // nothing is drawn at all.
      echo.getBoundingClientRect();
      echo.style.transition = 'transform 420ms ease-out, opacity 420ms ease-out';
      echo.style.transform = 'scale(1.9)';
      echo.style.opacity = '0';
      echoTimer = setTimeout(() => {
        echoTimer = 0;
        echo.style.transition = 'none';
        echo.style.transform = 'scale(0.72)';
        echo.style.opacity = '0';
      }, 440);
    },
    dispose() {
      if (hiddenTimer) clearTimeout(hiddenTimer);
      if (echoTimer) clearTimeout(echoTimer);
      hiddenTimer = 0;
      echoTimer = 0;
      if (root.parentNode) root.parentNode.removeChild(root);
    },
  };
}
