/**
 * Orbit-only camera rig, centred on the black hole.
 *
 * There is exactly one focus: `target`, the hole's world position. Left drag
 * orbits it, the wheel dollies towards or away from it, and neither gesture can
 * move it. Right drag and the context menu are disabled outright, because
 * panning is what used to walk the hole out of the frame.
 *
 * The one exception is an explicit station focus requested by the stage. That
 * is a temporary `focus` mode: the target eases onto the station, and the next
 * orbit gesture (or `exitFocus`/`reset`) eases it back to the hole. Keeping the
 * exception inside this rig means there is still a single controller writing
 * the camera transform.
 *
 * `dispose()` removes every listener, so a remounted panel never accumulates
 * duplicate handlers.
 */

import { Vector3 } from 'three';
import { CAMERA_HOME } from './dimensions.js';

/**
 * Absolute rig floors. The active mode's home may narrow these further.
 *
 * The ceiling is the outermost distance any mode is allowed to author, not the
 * hole's working limit: the hole fits its own ceiling to the viewport on every
 * resize (it lands near 13 units in a landscape window), the cluster authors
 * its own, and the nebula space needs ~120 to take in the whole shell. Keeping
 * the absolute stop generous is what lets each mode own its framing without a
 * second camera controller.
 */
const MIN_RADIUS = 6.0;
// The rig ceiling only exists so a mode cannot dolly into numerical fog; the
// black hole keeps its own much tighter limit. A portrait nebula box needs
// more room than a landscape one, hence the generous global bound.
const MAX_RADIUS = 320;
/** A station close-up may go nearer than the mode's own orbit floor. */
const FOCUS_MIN_RADIUS = 2.2;
const MIN_PHI = 0.24;
const MAX_PHI = Math.PI - 0.30;
/** Orbit speed, radians per CSS pixel of drag. */
const ROTATE_SPEED = 0.0052;
/** Exponential damping rate; higher settles faster. */
const DAMPING = 9.5;
/** Pointer travel before a press becomes an orbit gesture. Kept equal to the
 * stage's CLICK_SLOP so a gesture that turns the camera can never also count
 * as a station click. */
const DRAG_SLOP = 6;

export function createCameraRig(camera, element, options) {
  const opts = options || {};
  const homeDefaults = sphericalFromVector(CAMERA_HOME);
  // The hole's real world position. Read by the stage after the scene has been
  // assembled, instead of assuming the origin.
  const hole = toVector3(opts.target);

  /**
   * The authored framing this mode returns to. Phase 4 has two of them — the
   * hole overview and the category cluster — but both are the *same* controller
   * with a different home and orbit limits; nothing else about the input path
   * changes between modes.
   */
  const home = {
    radius: homeDefaults.radius,
    phi: homeDefaults.phi,
    theta: homeDefaults.theta,
    target: hole.clone(),
    minRadius: MIN_RADIUS,
    maxRadius: MAX_RADIUS,
  };

  const state = {
    radius: home.radius,
    phi: home.phi,
    theta: home.theta,
    target: hole.clone(),
  };
  const goal = {
    radius: home.radius,
    phi: home.phi,
    theta: home.theta,
    target: hole.clone(),
  };

  const offset = new Vector3();
  let drag = null;
  let disposed = false;
  let onChange = null;
  let mode = 'orbit';

  const notify = () => {
    if (onChange) onChange();
  };

  /**
   * Stop station framing and ease the focus back to this mode's home centre.
   * Orbit angles and distance are deliberately preserved: the user keeps the
   * viewpoint they had, only the centre returns.
   */
  function exitFocus() {
    if (mode === 'orbit' && goal.target.distanceToSquared(home.target) < 1e-10) return;
    mode = 'orbit';
    goal.target.copy(home.target);
    notify();
  }

  const onPointerDown = (event) => {
    if (drag) return;
    // Only the primary button acts. No pan, no secondary-button handling.
    if (event.button !== 0) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      downX: event.clientX,
      downY: event.clientY,
      moved: false,
    };
    // Capture keeps a fast drag tracking after the pointer leaves the canvas.
    if (typeof element.setPointerCapture === 'function') {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        /* pointer already released */
      }
    }
  };

  const onPointerMove = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (dx === 0 && dy === 0) return;

    if (!drag.moved) {
      // A click must not be mistaken for an orbit gesture. Only once the pointer
      // has travelled past the slop does the drag take over the camera.
      if (Math.hypot(event.clientX - drag.downX, event.clientY - drag.downY) <= DRAG_SLOP) return;
      drag.moved = true;
      // Orbiting always means orbiting the hole. Leave a temporary station
      // focus first, so the target cannot stay behind on the station.
      exitFocus();
    }

    goal.theta -= dx * ROTATE_SPEED;
    goal.phi = clamp(goal.phi - dy * ROTATE_SPEED, MIN_PHI, MAX_PHI);
    notify();
  };

  const endDrag = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    drag = null;
    if (typeof element.releasePointerCapture === 'function') {
      try {
        element.releasePointerCapture(event.pointerId);
      } catch {
        /* capture already gone */
      }
    }
  };

  const onWheel = (event) => {
    // Own the gesture: without this the panel scrolls while the user zooms.
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 240 : 1;
    const amount = clamp(event.deltaY * unit, -240, 240);
    goal.radius = clamp(goal.radius * Math.exp(amount * 0.0011), home.minRadius, home.maxRadius);
    notify();
  };

  const onContextMenu = (event) => {
    event.preventDefault();
  };

  element.addEventListener('pointerdown', onPointerDown);
  element.addEventListener('pointermove', onPointerMove);
  element.addEventListener('pointerup', endDrag);
  element.addEventListener('pointercancel', endDrag);
  element.addEventListener('wheel', onWheel, { passive: false });
  element.addEventListener('contextmenu', onContextMenu);

  /**
   * Advance damping and write the camera transform.
   * @returns true when the camera moved, so a paused stage knows to redraw.
   */
  function update(dt) {
    const k = 1 - Math.exp(-clamp(dt, 0.001, 0.1) * DAMPING);
    const prevRadius = state.radius;
    const prevPhi = state.phi;
    const prevTheta = state.theta;
    const prevX = state.target.x;
    const prevY = state.target.y;
    const prevZ = state.target.z;

    // Both ends are clamped again here, not only where the goal is written.
    // A viewport change can narrow the ceiling under a camera that is already
    // outside it; without this the live radius would keep easing towards a goal
    // it can no longer reach, and a single frame could paint past the boundary.
    goal.radius = clamp(goal.radius, home.minRadius, home.maxRadius);
    state.radius = clamp(state.radius, home.minRadius, home.maxRadius);
    state.radius += (goal.radius - state.radius) * k;
    state.phi += (goal.phi - state.phi) * k;
    state.theta += (goal.theta - state.theta) * k;
    state.target.lerp(goal.target, k);

    offset.setFromSphericalCoords(state.radius, state.phi, state.theta);
    camera.position.copy(state.target).add(offset);
    camera.lookAt(state.target);

    return (
      Math.abs(state.radius - prevRadius) > 1e-4 ||
      Math.abs(state.phi - prevPhi) > 1e-4 ||
      Math.abs(state.theta - prevTheta) > 1e-4 ||
      Math.abs(state.target.x - prevX) > 1e-4 ||
      Math.abs(state.target.y - prevY) > 1e-4 ||
      Math.abs(state.target.z - prevZ) > 1e-4
    );
  }

  /**
   * Ease the framing onto one point in space, without a second controller.
   *
   * The station ends up in the middle of the frame with the hole behind it, so
   * the eye keeps the spatial relationship while the node is unobstructed. The
   * orbit radius never drops below the rig's floor (the camera cannot pass
   * through the core). This is the only path that moves the focus off the hole,
   * and `exitFocus` is the only way back.
   */
  function focusOn(position, options) {
    const focusOpts = options || {};
    const distance = clamp(
      typeof focusOpts.distance === 'number' && Number.isFinite(focusOpts.distance)
        ? focusOpts.distance
        : 6.2,
      Math.min(home.minRadius, FOCUS_MIN_RADIUS),
      home.maxRadius,
    );
    mode = 'focus';
    goal.target.set(position.x, position.y, position.z);
    // Sit on the station's own bearing, a little to the side: the camera then
    // looks inwards along the disk, with the hole behind the station instead of
    // right in front of the lens. A large bearing offset swings the camera over
    // the shadow, which is what turns a close-up into a black wall.
    goal.theta = nearestAngle(Math.atan2(position.x, position.z) + 0.24, state.theta);
    goal.phi = 1.10;
    goal.radius = distance;
    notify();
  }

  /** Ease back to the authored default framing of the active mode. */
  function reset() {
    mode = 'orbit';
    goal.radius = home.radius;
    goal.phi = home.phi;
    // Coming from a long orbit, unwind the short way round instead of spinning
    // through several full turns.
    goal.theta = nearestAngle(home.theta, state.theta);
    goal.target.copy(home.target);
    notify();
  }

  /**
   * Narrow or widen the orbit limits without touching the authored framing.
   *
   * A resize does not re-author the view — the user keeps the angles and the
   * distance they had — but the new ceiling has to be enforced on the goal and
   * on the live radius immediately, so the next frame cannot paint outside it.
   */
  function setLimits(limits) {
    const next = limits || {};
    const minRadius = clamp(
      Number(next.minRadius) || home.minRadius,
      FOCUS_MIN_RADIUS,
      MAX_RADIUS,
    );
    const maxRadius = clamp(Number(next.maxRadius) || home.maxRadius, minRadius, MAX_RADIUS);
    if (minRadius === home.minRadius && maxRadius === home.maxRadius) return;
    home.minRadius = minRadius;
    home.maxRadius = maxRadius;
    home.radius = clamp(home.radius, minRadius, maxRadius);
    goal.radius = clamp(goal.radius, minRadius, maxRadius);
    state.radius = clamp(state.radius, minRadius, maxRadius);
    notify();
  }

  /**
   * Swap the authored framing — the hole overview or a category cluster — and
   * optionally ease onto it. The target stays the shared centre (both scenes
   * are built around the origin), so the input semantics never change; only
   * the orbit floor/ceiling and the home angles do.
   */
  function setHome(next, setOptions) {
    if (!next) return;
    const target = next.target ? toVector3(next.target) : home.target;
    home.radius = clamp(Number(next.radius) || home.radius, MIN_RADIUS, MAX_RADIUS);
    home.phi = clamp(Number(next.phi) || home.phi, MIN_PHI, MAX_PHI);
    home.theta = Number.isFinite(next.theta) ? next.theta : home.theta;
    home.target.copy(target);
    home.minRadius = clamp(
      Number(next.minRadius) || MIN_RADIUS,
      FOCUS_MIN_RADIUS,
      home.radius,
    );
    home.maxRadius = clamp(Number(next.maxRadius) || MAX_RADIUS, home.minRadius, MAX_RADIUS);
    // A saved framing can be past a ceiling that has since been narrowed (the
    // viewport is smaller, or the mode's limit changed). Clamp the authored
    // distance too, or returning to this mode would dolly out past the boundary.
    home.radius = clamp(home.radius, home.minRadius, home.maxRadius);
    if (setOptions && setOptions.animate === false) return;
    mode = 'orbit';
    goal.target.copy(home.target);
    goal.radius = home.radius;
    goal.phi = home.phi;
    goal.theta = nearestAngle(home.theta, state.theta);
    notify();
  }

  // Place the camera at home immediately so the very first frame is correct.
  update(1);

  return {
    /** Register a callback fired on input and while damping is settling. */
    setOnChange(fn) {
      onChange = typeof fn === 'function' ? fn : null;
    },
    update,
    reset,
    focusOn,
    exitFocus,
    setHome,
    setLimits,
    /** Current spherical framing, for the stage's LOD readout and tests. */
    framing() {
      return {
        mode,
        radius: state.radius,
        phi: state.phi,
        theta: state.theta,
        target: { x: state.target.x, y: state.target.y, z: state.target.z },
        hole: { x: hole.x, y: hole.y, z: hole.z },
        home: {
          radius: home.radius,
          phi: home.phi,
          theta: home.theta,
          minRadius: home.minRadius,
          maxRadius: home.maxRadius,
          target: { x: home.target.x, y: home.target.y, z: home.target.z },
        },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', endDrag);
      element.removeEventListener('pointercancel', endDrag);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('contextmenu', onContextMenu);
      onChange = null;
    },
  };
}

function toVector3(value) {
  if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
    return new Vector3(value.x, value.y, value.z);
  }
  return new Vector3(0, 0, 0);
}

/**
 * Angle equivalent to `angle` that is closest to `reference`, so a reset or a
 * focus does not spin the long way around the orbit.
 */
function nearestAngle(angle, reference) {
  const turn = Math.PI * 2;
  return angle + turn * Math.round((reference - angle) / turn);
}

function sphericalFromVector(v) {
  const radius = Math.hypot(v.x, v.y, v.z);
  const phi = Math.acos(clamp(v.y / radius, -1, 1));
  const theta = Math.atan2(v.x, v.z);
  return { radius, phi, theta };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
