/**
 * Black Hole Radio — the lazily loaded WebGL stage (phase 4).
 *
 * This file is the ONLY place three.js is imported. It is bundled by
 * `tools/build-stage.mjs` into a self-contained `client.stage.js` chunk that
 * carries its own copy of three, and that chunk is requested on demand through
 * the harness module system (`require.async('./client.stage.js')`) the first
 * time the panel actually mounts. Nothing here runs at plugin boot.
 *
 * The stage is one place with three depths, not three pages. Every depth draws
 * the same scene — the same starfield at the same brightness, the same renderer,
 * the same camera rig, the same station buffers — and only the arrangement of
 * the stations and the camera's orbit change:
 *
 *   black-hole  the hole, the photon ring and the accretion disk, with the whole
 *               catalogue embedded in the disk's matter field;
 *   cluster     the same stations gathered into one star cluster per genre,
 *               the hole's structures faded out.
 *
 * The gestures follow the depths. A depth is not a page: there is no cut, no
 * second scene and no chrome of its own.
 *
 *   black-hole ──left-hold the hole (2.3 s)──▶ cluster
 *   cluster    ──right-hold anywhere but a card (2.3 s)──▶ black-hole
 *   any depth  ──short right press (under 120 ms)──▶ hand the library point to
 *               the panel, which draws the list where the press landed
 *   cluster    ──click a station──▶ play it
 *   any depth  ──Esc──▶ leave the radio page
 *
 * Everything between depths is one continuous state value (`progress`) plus the
 * station layer's per-station blend. There is no second state that makes the
 * frame black in between: the hole shrinks out of its own disc, the disc
 * scatters into the cluster, and the same numbers run backwards to re-form it.
 * Nothing is ever rebuilt, so an interrupted gesture keeps moving from where it
 * is instead of snapping.
 *
 * The sky is one sky. `starfield` is never dimmed by a depth change, because a
 * depth change is a rearrangement of the same stars, not a different background.
 *
 * The interaction machine (single source of truth for the panel) funnels the
 * pointer, the hold and the keyboard; the panel never writes scene state
 * directly.
 */

import {
  ACESFilmicToneMapping,
  Color,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createAccretionDisk } from './scene/accretion-disk.js';
import { createDiscTransfer, DISC_TRANSFER_LANDING, discTransferHandoff } from './scene/disc-transfer.js';
import { buildStationField, rewriteStationBits } from './scene/station-field.js';
import { createCameraRig } from './scene/camera-rig.js';
import { createCameraFrame } from './scene/camera-frame.js';
import { createSpaceHaze } from './scene/space-haze.js';
import { createStarfield } from './scene/starfield.js';
import {
  HORIZON_RADIUS,
  CRITICAL_IMPACT_PARAMETER,
  DISK_INNER,
  DISK_OUTER,
  RS,
  maxOrbitRadiusForShadow,
  shadowAngularRadius,
} from './scene/dimensions.js';
import { createStationsLayer } from './nodes/stations-layer.js';
import { createHoldRing } from './nodes/hold-ring.js';
import { createRadioOverlay } from './nodes/radio-overlay.js';
import {
  fixtureByGpuId,
  selectRadioFixtures,
  shaderFixtures,
} from './scene/radio-fixtures.js';
import { buildClusterLayout, projectedDiameter, scatterStations } from './cluster/layout.js';
import { GENRE_IDS } from './radio/genres.js';

/** Surface this module's phase honestly, in one place. */
export const STAGE_PHASE = 'phase-5';

/** Drags longer than this (CSS px) are camera gestures, never selections. */
const CLICK_SLOP = 6;
/** Hover picking is throttled: a pointer moving across 2,000 dots must not
 * run 2,000 projections per pointer event. */
const HOVER_INTERVAL_MS = 90;
/** Touch has no hover, so holding a station this long asks for its card. */
const TOUCH_CARD_MS = 480;
/** Touch has no right button either, so holding empty space this long goes back. */
const TOUCH_BACK_MS = 600;
/** A press held longer than this is not a click, whatever else it did. */
const PRESS_CLICK_MS = 800;
/** Progress units per second; the full transition takes ~1.05 s. */
const TRANSITION_RATE = 0.95;

/**
 * The form change, in seconds from the press.
 *
 * One timeline, not two: the ring fills during the same window the geometry
 * starts to give way, so the horizon is already moving when the ring locks and
 * the distance left after the commit is short. Every segment below is a wall
 * clock reading, so a dropped frame shortens the wait instead of stretching it.
 * Both buttons use the same clock and the same curve: the left one runs it
 * forwards, the right one runs it backwards.
 */
const WORM_RING_S = 1.0;
/** The hold's full length. Short of it, the release is a cancel. */
const WORM_END_S = 2.3;
/** Reduced motion keeps one short leg rather than borrowing the full one. */
const WORM_CALM_S = 0.2;
/**
 * The ring has been recognised as a hold. Only feedback: the timeline below is
 * untouched, and the press still has to run to WORM_END_S to commit.
 */
const HOLD_PULSE_S = 0.6;
/** Movement beyond this many CSS px turns a hold into a camera drag. */
const WORM_DEADZONE_PX = CLICK_SLOP;
/** How long an abandoned hold takes to retreat to where the frame was (ms/s). */
const WORM_RECOIL_S = 0.22;
/**
 * How long the right button must stay down before its hold begins. The same
 * press is both the "one level back" hold and, released inside this window,
 * nothing at all: waiting a click's length before drawing the ring keeps a
 * short right press from flashing one. The hold's clock still starts at the
 * real press, so the gesture itself is not a millisecond longer.
 */
const RIGHT_HOLD_DELAY_S = 0.12;
/** Reduced motion: no path, one 200 ms cross-fade. */
const WORM_CALM_RATE = 1 / WORM_CALM_S;
/** Catalogue brightness while the hole is the subject. */
const HOLE_STATION_DIM = 0.55;

/** The black-hole camera framing, restored on exit. */
const HOLE_MIN_RADIUS = 3.6;
/**
 * Absolute far stop for the hole view, before the viewport fit.
 *
 * The old limit was a flat 44 world units. At 44 the shadow was ~12% of the
 * viewport's short edge in a normal landscape window — the hole read as a dot
 * in empty space. The fit below now derives the working limit from the actual
 * box (roughly 13 units at 1280x720), and this constant only remains as a hard
 * ceiling for extreme window shapes, so the camera can never dolly out past the
 * distance where the scene stops being a composition at all.
 */
const HOLE_MAX_RADIUS = 44.0;
/** Shadow diameter floor, as a fraction of the viewport's short edge. */
const SHADOW_SHORT_EDGE_FRACTION = 0.2;

/**
 * Mount the stage into `container`.
 *
 * @param container - the element the canvas is appended to. It must already be
 *   in the document with a non-zero box; the caller guarantees that because the
 *   panel only mounts after the reserved region is measured.
 * @param options - validated stage knobs from the Host half, plus the catalogue.
 * @param options.stations - plain station records (id, name, position, …).
 * @param options.seed - catalogue seed, used for deterministic per-node jitter.
 * @param options.categories - category anchors (id, count, position).
 * @param options.language - 'zh' | 'en'.
 * @param options.onSelect - fired with (station|null) for selections.
 * @param options.onMode - fired with the machine snapshot on every change.
 * @param options.onHoleTap - the hole centre was clicked: the search box's
 *   opening gesture. Holding the centre is the way into the cluster instead.
 * @param options.onPlay - fired with (station, index) when a click asked for
 *   transport on the disk. The stage does not play anything itself: it reports
 *   the intent and the panel decides what "play" means there.
 * @param options.onHover - fired with ({index, station, x, y, touch}) when the
 *   pointer settles on a station, and with null when it leaves one. The panel
 *   owns the timing of any card; the stage only reports what is under the
 *   pointer. `touch` says the report came from a long press, not a hover.
 * @param options.onFavourites - fired with (x, y) when a short right press in
 *   the scene is released before it turns into a hold: the library opens where
 *   the press landed. The stage never draws that list itself.
 * @returns a handle with selection, mode, camera and measurement helpers.
 */
export function mountStage(container, options) {
  const settings = options || {};
  const antialias = settings.antialias !== false;
  const pixelRatioCap = clampRatio(settings.pixelRatioCap);
  const reducedMotion = settings.reducedMotion === true;
  // The switch restores the old behaviour — a plain cross-fade — for A/B
  // comparison and for a rollback that needs no code change.
  const wormholeEnabled = settings.wormhole !== false;
  const language = settings.language === 'en' ? 'en' : 'zh';

  const catalog = resolveCatalog(settings);
  const stations = catalog.stations;
  const categories = catalog.categories;
  // Genre volumes are a render-time input, never a classification: the host
  // hands over the already-counted visible genres from the repository, and the
  // layout only decides where they sit.
  const genres = catalog.genres;
  // The cluster field is the page: one gob per genre, arranged by layout.
  const featuredCount = stations.reduce((sum, station) => sum + (station.isFeatured ? 1 : 0), 0);

  const scene = new Scene();
  scene.background = new Color(0x030408);

  const camera = new PerspectiveCamera(42, 1, 0.1, 400);

  let renderer;
  try {
    renderer = new WebGLRenderer({ antialias, alpha: false, powerPreference: 'high-performance' });
  } catch (error) {
    throw new Error(`WebGL context unavailable: ${describe(error)}`);
  }

  const ratio = Math.min(window.devicePixelRatio || 1, pixelRatioCap);
  renderer.setPixelRatio(ratio);
  renderer.setClearColor(0x030408, 1);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.outputColorSpace = SRGBColorSpace;

  const canvas = renderer.domElement;
  canvas.setAttribute('data-bhrl-canvas-el', 'true');
  canvas.setAttribute('data-bhrl-stations', String(stations.length));
  canvas.setAttribute('tabindex', '0');
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Black Hole Radio');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';
  canvas.style.outline = 'none';
  // The renderer clears to the sky colour, but a lost context leaves the canvas
  // element itself transparent, which would flash the host page's white through
  // the whole stage until the context comes back. Painting the element keeps the
  // frame black through a loss and through the first restored frame.
  canvas.style.background = '#030408';
  container.appendChild(canvas);

  const parts = [];
  const disposers = [];

  const add = (part) => {
    if (part && part.object) scene.add(part.object);
    if (part) parts.push(part);
    return part;
  };

  try {
    // The shared sky goes in first and lowest: every form sees the same
    // background, and the hole's imaging quad (renderOrder -10, opaque) paints
    // its lensed copy straight over it.
    const updateCameraFrame = createCameraFrame(renderer);
    const spaceHaze = add(createSpaceHaze({ renderer }));
    disposers.push(() => spaceHaze.dispose());

    const starfield = add(createStarfield());
    starfield.setPixelRatio(ratio);

    const disk = add(createAccretionDisk({ renderer }));
    // There is no shadow sphere any more. The hole is dark because the traced
    // light never comes back, which is the same reason a real one is dark. The
    // camera still orbits a fixed centre, and that centre is the origin the
    // imaging pass is built around.
    const holeCenter = new Vector3(0, 0, 0);

    const rig = createCameraRig(camera, canvas, { target: holeCenter });
    disposers.push(() => rig.dispose());

    const layer =
      stations.length > 0
        ? add(createStationsLayer(stations, { seed: catalog.seed, pixelRatio: ratio }))
        : null;
    const discTransfer = add(createDiscTransfer(renderer));
    if (layer) {
      scene.add(layer.marker);
      // The hole's own image has to win the first glance: the catalogue is
      // still there, but it reads as matter in the disk, not as the subject.
      layer.setDim(HOLE_STATION_DIM);
    }

    // Bake the catalogue into the disc's density field. This is what makes the
    // stations the disc rather than a layer over it: every station contributes
    // mass at its own radius and azimuth, and the imaging shader samples that
    // distribution wherever a pixel's ray crosses the disc plane.
    let isFavouriteStation = null;
    let builtStationField = null;
    const rebuildStationField = () => {
      if (!stations.length) return false;
      // Favouriting touches two bits of one channel. Rewriting those bits costs
      // a few milliseconds; rebuilding the whole raster would drop a frame.
      if (builtStationField) {
        rewriteStationBits(builtStationField, stations, { isFavourite: isFavouriteStation });
        return Boolean(disk.setStationField(builtStationField));
      }
      const field = buildStationField(stations, { isFavourite: isFavouriteStation });
      if (!field || !field.count) return false;
      builtStationField = field;
      return Boolean(disk.setStationField(field));
    };
    rebuildStationField();

    // The ring that feeds the hold. The transition itself is the matter layer
    // reorganising, so there is no extra pass and no extra DOM besides this one
    // indicator: with `wormhole: false` the mount is the old stage byte for byte.
    const holdRing = wormholeEnabled ? createHoldRing(container) : null;
    if (holdRing) disposers.push(() => holdRing.dispose());

    // Phase-2 fixture suite. The switch is explicit (`?bhrlRadio=`), so a page
    // without it behaves exactly as the phase-1 baseline did: no overlay, no
    // probes, no upload.
    const radioFixtures = selectRadioFixtures(settings.radio);
    // The upload order is fixed: all four slots are always sent, in suite order,
    // whatever the selector enabled. A mask bit therefore means "slot i", never
    // "i-th enabled fixture" — the two agree only for a prefix of the suite.
    const radioSlots = shaderFixtures();
    const radioSlotOf = new Map(radioSlots.map((slot, index) => [slot.businessId, index]));
    const radioMaskBit = (businessId) => {
      const slot = radioSlotOf.get(businessId);
      return slot === undefined ? 0 : 1 << slot;
    };
    const radio = radioFixtures.length > 0 ? createRadioOverlay(container) : null;
    if (radio) {
      disposers.push(() => radio.dispose());
      const slots = radioSlots;
      const enabled = new Set(radioFixtures.map((fixture) => fixture.businessId));
      let mask = 0;
      slots.forEach((slot, index) => {
        if (enabled.has(slot.businessId)) mask |= 1 << index;
      });
      disk.setRadio(slots, mask);
    }
    const drawingBuffer = { x: 1, y: 1 };
    const radioState = {
      anchors: [],
      selectedId: null,
      selectedBranch: 0,
      lastScan: -1e9,
      cameraKey: '',
      stale: true,
      frameVersion: 0,
    };

    const viewport = { w: 0, h: 0 };
    let currentLod = 0;
    let selectedIndex = -1;
    let selectedId = null;
    const idToIndex = new Map(stations.map((station, index) => [station.id, index]));
    const projected = new Vector3();
    const pointerRay = new Vector3();
    const focusTarget = new Vector3();
    const selectedStation = () => (selectedIndex >= 0 ? stations[selectedIndex] : null);

    let labelLanguage = language;
    const labelPoint = new Vector3();

    /**
     * The one interaction machine. `mode` and `ui` are deliberately separate:
     * search is an overlay on the hole state, while mode describes which space
     * the camera and scene are in.
     */
    const machine = {
      mode: 'black-hole',
      ui: 'black-hole',
      categoryId: null,
      progress: 0,
      target: 0,
      layout: null,
      pendingFocus: null,
      savedCamera: null,
      /**
       * Hold pressure, 0..1. The disc winds up and swells under the ring; the
       * burst itself follows `progress`, so this only ever has to unwind.
       */
      wormCharge: 0,
      /** How far the frame has been dimmed for the fold, 0..1. */
      wormDark: 0,
    };
    const layoutCache = new Map();
    let lastModeKey = '';
    let transitioning = false;

    // Where each berth was left. Coming back to a category the user has already
    // opened returns to the bearing and zoom they left it at, not to the default
    // framing — the scene is one place, and a place remembers where you stood.
    const berthCameras = new Map();

    const positionOf = (index) => {
      if (layer) layer.positionInto(index, labelPoint);
      else if (stations[index] && stations[index].position) {
        labelPoint.set(stations[index].position.x, stations[index].position.y, stations[index].position.z);
      }
      return labelPoint;
    };

    const cloudVector = new Vector3();

    /**
     * Push a world point through the camera and out into CSS pixels.
     * Returns null when the point is behind the camera.
     */
    const projectCloud = (point) => {
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      cloudVector.copy(point).project(camera);
      if (cloudVector.z > 1) return null;
      return {
        x: (cloudVector.x * 0.5 + 0.5) * viewport.w,
        y: (-cloudVector.y * 0.5 + 0.5) * viewport.h,
        distance: camera.position.distanceTo(point),
        radius: (1 / Math.max(tan, 1e-4)) * (viewport.h * 0.5),
      };
    };

    const applySize = (force = false) => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (!force && w === viewport.w && h === viewport.h) return false;
      viewport.w = w;
      viewport.h = h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      // The imaging shader rebuilds each ray from gl_FragCoord, so it needs the
      // drawing-buffer size rather than the CSS size.
      const buffer = renderer.getDrawingBufferSize(new Vector2());
      drawingBuffer.x = buffer.x;
      drawingBuffer.y = buffer.y;
      disk.setViewport(buffer.x, buffer.y);
      starfield.setPixelRatio(renderer.getPixelRatio());
      if (layer) {
        layer.setPixelRatio(renderer.getPixelRatio());
        layer.setViewport(w, h, camera.fov);
      }
      if (radio) radio.resize(w, h, renderer.getPixelRatio());
      // The hole's far limit is a property of the box, not a constant: opening
      // the sidebar narrows the canvas, and a ceiling authored for the full
      // window would let the shadow fall below its size floor there. A cluster
      // keeps the limit its own layout authored, so only the hole is refitted.
      if (machine.target < 0.5 && machine.mode === 'black-hole') {
        rig.setLimits(holeOrbitLimits());
      }
      return true;
    };

    /**
     * The hole view's distance limits for the current canvas.
     *
     * At the old flat ceiling of 44 units the shadow was ~12% of the short edge
     * in a landscape window: the hole read as a dot. The ceiling is now derived
     * from the box so the shadow's DIAMETER stays at least
     * SHADOW_SHORT_EDGE_FRACTION of the short edge, which lands near 13 units at
     * 1280x720. The disc was checked at that distance too: its outer rim
     * (12 Rs) projects to ~93% of the half-height there, so the whole disc stays
     * inside the frame instead of being cropped as it was at the default zoom.
     */
    function holeOrbitLimits() {
      return {
        minRadius: HOLE_MIN_RADIUS,
        maxRadius: maxOrbitRadiusForShadow({
          width: viewport.w || 1280,
          height: viewport.h || 720,
          fovDegrees: camera.fov,
          minRadius: HOLE_MIN_RADIUS,
          hardMax: HOLE_MAX_RADIUS,
          shortEdgeFraction: SHADOW_SHORT_EDGE_FRACTION,
        }),
      };
    }

    let frame = 0;
    let disposed = false;
    let visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    let contextLost = false;
    let elapsed = 0;
    let last = 0;
    let dirty = true;

    /**
     * The apparent shadow on screen.
     *
     * The edge of the shadow is not at b_crit / r. A static observer at finite
     * distance sees it at sin(psi) = b_crit * sqrt(1 - Rs / r) / r, which is
     * what shadowAngularRadius returns; at the default camera distance that is
     * 6.95% smaller than the naive ratio, and the ratio itself is a tangent, not
     * a sine. Both corrections are applied here.
     */
    const silhouette = () => {
      projected.copy(holeCenter).project(camera);
      const x = (projected.x * 0.5 + 0.5) * viewport.w;
      const y = (0.5 - projected.y * 0.5) * viewport.h;
      const distance = Math.max(HORIZON_RADIUS * 1.0001, camera.position.distanceTo(holeCenter));
      const psi = shadowAngularRadius(distance);
      const halfFov = (camera.fov * Math.PI) / 360;
      const fraction = Number.isFinite(psi) ? Math.tan(psi) / Math.tan(halfFov) : 1;
      return {
        x,
        y,
        r: fraction * viewport.h * 0.5,
        criticalRadius: CRITICAL_IMPACT_PARAMETER,
      };
    };

    /**
     * The centre's hit region. It is a little larger than the shadow itself so
     * the edge is forgiving, and it is measured in CSS pixels so a far orbit
     * still leaves a usable target — but it never grows past a third of the
     * viewport, which would steal clicks from the disk.
     */
    const centerRegion = () => {
      const hole = silhouette();
      const radius = Math.min(
        Math.max(hole.r * 1.12, 42),
        Math.max(56, Math.min(viewport.w, viewport.h) * 0.33),
      );
      return { x: hole.x, y: hole.y, r: radius, hole };
    };

    const computeLod = () => {
      const distance = camera.position.distanceTo(holeCenter);
      return clamp01((distance - 7.0) / (26.0 - 7.0));
    };

    /** Applied to every scene part from the two transition values. */
    const applyTransition = () => {
      // Dissolution and gathering share the hold's progress from the first
      // frame. The commit threshold does not switch layouts or cut the image.
      const rise = smoothstep01(machine.progress);

      // The arriving space drives the hole out. The hole leaves a little after
      // the content starts moving, and returns a little before it arrives: the
      // matter should look reorganised, not cross-faded.
      // Hold pressure is not a source of "the hole is leaving": the disc is
      // winding up under the shadow, and the shadow itself must not move. The
      // hold only makes the traced disc's own points brighter and hotter, which
      // is the only way to show a wind-up without drawing a second population
      // of points over the first.
      const charge = clamp01(machine.wormCharge);
      const holeFade = smoothstep01(clamp01((rise - 0.05) / 0.62));
      // A captured source cell and the imaged disc are NEVER drawn together.
      // During the passage this pass supplies only the sky/shadow; all visible
      // disc material lives in discTransfer, including the gas between stations.
      // The return curve is for the way back only. A crossing that ended on
      // the cluster leaves `returning` set on the hold that carried it, and
      // reading it there kept the disc opaque over a finished hand-off.
      const transferred = discTransfer.active;
      const returning = machine.returning === true && !transferred;
      const handoff = transferred ? discTransferHandoff(machine.progress) : 1;
      discTransfer.setProgress(machine.progress);
      disk.setDiscTransfer(transferred ? Math.min(1, machine.progress / DISC_TRANSFER_LANDING) : -1);
      // Outward, the hole fades as the cluster arrives. Homeward it has to be
      // in frame from the first pixel: the rig pulls the camera back through
      // the distance the outward trip covered, so a hole that is still black at
      // progress 0.67 does not grow into the frame — it appears in it, already
      // large. `1 - holeFade` is the outward curve, and reusing it here was
      // exactly that bug: `leaving` sits above 0.67 for the first third of the
      // return, so opacity stayed at zero while the camera had already moved.
      // The homeward leg rebuilds the live disc out of the captured fragments
      // instead of cross-fading a disc back over them: the same points that
      // left as material gather along the spiral into the ring they sat on.
      const gather = !(returning || transferred);
      const discOpacity = returning
        ? smoothstep01(clamp01(1 - machine.progress))
        : transferred ? 1 - handoff : gather ? 1 - rise : 1 - holeFade;
      disk.setOpacity(discOpacity);
      // Homeward, the gas pulls back off the horizon, so the shadow it was
      // covering emerges from under it: the hole grows instead of appearing at
      // full size. `setDiscInner` is the only control that changes the shadow's
      // radius without touching the camera or the trace. Outward it stays at
      // ISCO — there the hole leaves by fading, which already reads as a shrink.
      disk.setDiscInner(
        returning
          ? 1.2 + (DISK_INNER / RS - 1.2) * smoothstep01(clamp01(1 - machine.progress))
          : DISK_INNER / RS,
      );
      disk.setStationEmission(0.30);
      disk.setStationGain(5);

      // The disc winds up on its own: a differential twist in the pattern plus
      // a little vertical shear. This is the hold's whole visible effect, and it
      // lives inside the one disc the frame already has.
      disk.setCharge(charge);
      // The disc's inner edge does not move. Walking it inward put a second,
      // thicker ring of gas around the shadow — the gas reaching closer is
      // exactly what the frame does not need while the points are being pulled
      // out of it. The shadow is left to the light: it goes when the disc goes.
      // Kept so this call site need not know that the analytic ring is gone:
      // the imaging pass draws the ring where the winding piles up, itself.
      disk.setRingIntensity(0.62 * discOpacity);
      // The light goes before the geometry does. The two cones have to read as
      // one silhouette, and the fold has to happen where the eye can finish the
      // shape itself instead of being shown a lit diagram of it.
      const dark = clamp01(machine.wormDark);
      renderer.toneMappingExposure = 1.15 + 0.08 * charge - 0.74 * dark;

      // The starfield stays as the deep background in the cluster space: the
      // camera sits inside its outer shells there.
      // The sky is one sky. Dimming it as the cluster arrives was reading as
      // "the background changed", which is exactly what this page is not allowed
      // to do: the two states share one field of stars at one brightness.
      starfield.setDim(0);
      if (layer) {
        // The cluster is the same station cloud rearranged, so the cluster
        // amount is what fades the stations that are not part of what is on
        // screen.
        layer.setReturning(returning);
        // The gather runs on the same `rise` as the outward trip. `returning`
        // only changes the flight path (stations spiral onto their disc anchors
        // instead of following the cubic). It must NOT freeze these uniforms at
        // the cluster values: doing that left the cloud exactly where it was and
        // merely dimmed it out over the arriving disc, which read as a second
        // disc layer rather than the stars becoming this one.
        layer.setClusterAmount(rise);
        // The normal particle population is a resting-state representation,
        // not an in-flight substitute. It returns only after the source cells
        // have reached their station destinations.
        layer.object.visible = !transferred || handoff > 0;
        layer.setHoleOnly(clamp01(1 - clamp01(rise * 1.6)));

        layer.setDiskMatter(clamp01(1 - rise));
        // Settles exactly on the resting hole view (dim = HOLE_STATION_DIM),
        // so the last frame of the gather and the first resting frame match.
        layer.setDim((HOLE_STATION_DIM + (1 - HOLE_STATION_DIM) * clamp01(rise * 2)) * handoff);
      }
      if (rise > 0.001) dirty = true;
    };

    const frameTimes = [];
    const frameDeltas = [];
    let pauseCount = 0;
    let qualityAt = 0;
    let qualitySlow = 0;
    const updateTransitionQuality = (now, rawMs) => {
      const active = Boolean(worm.kind);
      const current = renderer.getPixelRatio();
      // A bounded raster budget on entry; lower again only after consecutive
      // slow frames. Do not change the particle path, clock or brightness.
      const budget = Math.min(ratio, Math.max(0.5, Math.sqrt(700000 / Math.max(1, viewport.w * viewport.h))));
      qualitySlow = active && rawMs > 21 && rawMs <= 200 ? qualitySlow + 1 : 0;
      if (now - qualityAt < 300) return;
      let next = current;
      if (active && current > budget + 0.01) next = budget;
      else if (active && qualitySlow >= 3) next = Math.max(Math.min(0.5, ratio), current * 0.8);
      else if (!active && current < ratio) next = Math.min(ratio, current + 0.1);
      if (Math.abs(next - current) < 0.01) return;
      qualityAt = now;
      qualitySlow = 0;
      renderer.setPixelRatio(next);
      applySize(true);
      dirty = true;
    };

    // GPU timing, when the driver exposes it. renderer.render() returns when the
    // CPU has finished submitting commands, not when the GPU has finished
    // drawing, so its wall time is reported separately and never called GPU cost.
    const gl = renderer.getContext();
    const timerExt = typeof gl.getExtension === 'function'
      ? gl.getExtension('EXT_disjoint_timer_query_webgl2')
      : null;
    const gpuQueries = [];
    const gpuSamples = [];
    let gpuDisjoint = 0;
    /** Drop every query still in flight. Used on disjoint, loss and teardown. */
    const discardGpuQueries = () => {
      while (gpuQueries.length) gl.deleteQuery(gpuQueries.shift());
    };
    const collectGpuTimings = () => {
      if (!timerExt) return;
      if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
        // A disjoint event means the clock changed underneath the queries; every
        // value still in flight is unusable.
        gpuDisjoint += 1;
        discardGpuQueries();
        return;
      }
      while (gpuQueries.length) {
        const query = gpuQueries[0];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        // There is no per-query disjoint flag in WebGL2: getQueryParameter accepts
        // only QUERY_RESULT and QUERY_RESULT_AVAILABLE. The global GPU_DISJOINT_EXT
        // test above is the whole disjoint check, and asking for anything else here
        // raised INVALID_ENUM on every frame.
        gpuSamples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        if (gpuSamples.length > 120) gpuSamples.shift();
        gl.deleteQuery(query);
        gpuQueries.shift();
      }
    };

    const draw = () => {
      collectGpuTimings();
      const query = timerExt ? gl.createQuery() : null;
      if (query) gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
      const started = performance.now();
      renderer.render(scene, camera);
      if (query) {
        gl.endQuery(timerExt.TIME_ELAPSED_EXT);
        gpuQueries.push(query);
      }
      frameTimes.push(performance.now() - started);
      if (frameTimes.length > 120) frameTimes.shift();
      // Fixture labels are the only text the stage paints. They belong to the
      // hole's own picture; the cluster frame carries no fixtures and no names.
      if (machine.progress > 0.02) {
        if (radio) radio.clear();
      } else {
        updateRadioOverlay();
      }
      dirty = false;
    };

    const tick = (now) => {
      frame = 0;
      if (disposed || !visible || contextLost) return undefined;
      // Two clock numbers with different jobs. `rawMs` is what the browser
      // actually delivered and is the only honest input to frame statistics;
      // `dt` is clamped so a hitch cannot teleport the animation.
      const rawMs = last === 0 ? 1000 / 60 : Math.max(1, now - last);
      last = now;
      // A gap this long is a resume (tab hidden, page frozen, still loading), not
      // a slow frame. Charging it to the statistics is how a "frame time" number
      // ends up measuring a lunch break.
      if (rawMs > 200) {
        pauseCount += 1;
      } else {
        frameDeltas.push(rawMs);
        if (frameDeltas.length > 240) frameDeltas.shift();
      }
      const dt = Math.min(0.05, Math.max(0.001, rawMs / 1000));
      updateTransitionQuality(now, rawMs);

      const moved = rig.update(dt);
      if (moved) dirty = true;

      // Advance the one transition value. Reversing simply flips the sign of
      // this climb; no queue, no competing tween.
      // A hold/recoil owns progress exclusively; the ordinary navigation tween
      // must not pull it back toward the previous page between two hold frames.
      if (!worm.kind && machine.progress !== machine.target) {
        const delta = machine.target - machine.progress;
        const step = TRANSITION_RATE * dt;
        machine.progress += Math.sign(delta) * Math.min(Math.abs(delta), step);
        if (Math.abs(machine.target - machine.progress) < 1e-4) machine.progress = machine.target;
        transitioning = machine.progress !== machine.target;
        applyTransition();
        dirty = true;
        if (!transitioning) finishTransition();
      }

      if (!reducedMotion) {
        elapsed += dt;
        starfield.update(elapsed, dt);
        dirty = true;
      }

      // Resolve the timeline before uploading particle buffers and disk uniforms.
      advanceWormhole(now);

      // A landing that happened above only put its blend on the layer; the
      // disc uniforms are authored here, and this is the upload that draws the
      // endpoint. Without it the matrix keeps the entry picture.
      if (worm.pulseEnd || worm.landed) applyTransition();

      currentLod = computeLod();
      if (layer) {
        layer.setLod(currentLod);
        const hole = silhouette();
        layer.setHole(hole.x, hole.y, hole.r * 1.02);
        // Visibility belongs to applyTransition; do not overwrite its handover
        // here after the timeline has authored this frame.
        if (layer.update(dt, camera, viewport.h)) dirty = true;
        // The grid lives on the render loop, not on the pointer: a camera move
        // has to refresh it even when the pointer never moves again.
        refreshPickable();
      }

      const cameraFrame = updateCameraFrame(camera);
      disk.update(elapsed, camera, cameraFrame);
      spaceHaze.update(elapsed, camera, cameraFrame);

      // Adaptive density: the pickable budget drops before the frame rate does,
      // which keeps the disk clickable instead of turning laggy. One decision
      // per second, with a dead band between 45 and 55 fps so a merely noisy
      // frame cannot make the target set oscillate.
      if (now - pickLevelAt > 1000 && frameDeltas.length >= 30) {
        pickLevelAt = now;
        let total = 0;
        for (let n = 0; n < frameDeltas.length; n += 1) total += frameDeltas[n];
        const fps = 1000 / (total / frameDeltas.length);
        if (fps < 45 && pickableLevel < PICKABLE_BUDGETS.length - 1) pickableLevel += 1;
        else if (fps > 55 && pickableLevel > 0) pickableLevel -= 1;
      }

      // The eased field spin only moves when frames are drawn, and hovering is
      // the one interaction that happens with a still camera: keep drawing
      // until it has settled, or resuming after the card closes would only be
      // visible the next time something else asked for a frame.
      if (disk && typeof disk.isStationSpinSettled === 'function' && !disk.isStationSpinSettled()) {
        dirty = true;
      }

      if (dirty) draw();
      // Only acknowledge completion after the exact end-state buffers were
      // uploaded and rendered. A full progress ring must never lead the image.
      // The crossing drew its endpoint in the frame above: the ring fills and
      // the mode is reported together, never before the image.
      if (worm.pulseEnd) {
        worm.pulseEnd = false;
        if (worm.kind === null && machine.mode !== 'cluster' && machine.target > 0.5) {
          machine.mode = 'cluster';
          notifyMode();
        }
        if (holdRing) holdRing.complete();
        dirty = true;
        requestFrame();
      }
      // An exit has no `pulseEnd`: `handOver` already snapped progress to the
      // target, so the tween above never runs and finishTransition is not
      // reached. This is the one place that can retire the ring and put the
      // machine back in the hole after the endpoint has been drawn.
      if (worm.landed) finishWormhole();
      const morphing = layer ? layer.isAnimating : false;
      if (
        !reducedMotion ||
        moved ||
        morphing ||
        transitioning ||
        worm.kind ||
        renderer.getPixelRatio() < ratio - 0.01
      ) {
        // Scheduling goes through the same guard requestFrame uses: the hold can
        // have asked for the next frame from inside this one already.
        if (!frame) frame = requestAnimationFrame(tick);
      }
      else last = 0;
      return undefined;
    };

    const requestFrame = () => {
      if (frame || disposed || !visible || contextLost) return;
      frame = requestAnimationFrame(tick);
    };

    rig.setOnChange(requestFrame);
    disposers.push(() => rig.setOnChange(null));

    const projectStation = (index) => {
      const station = stations[index];
      if (!station) return null;
      if (layer) layer.positionInto(index, projected);
      else if (station.position) projected.set(station.position.x, station.position.y, station.position.z);
      else return null;
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) return null;
      return {
        x: (projected.x * 0.5 + 0.5) * viewport.w,
        y: (0.5 - projected.y * 0.5) * viewport.h,
        depth: projected.z,
      };
    };

    /**
     * The same projection, into a caller-owned slot.
     *
     * `projectStation` allocates its result; the pickable rebuild runs over the
     * whole catalogue, so using it there would allocate tens of thousands of
     * short-lived objects every refresh.
     */
    const projectScreenInto = (index, out) => {
      const station = stations[index];
      if (!station) return false;
      if (layer) layer.positionInto(index, projected);
      else if (station.position) projected.set(station.position.x, station.position.y, station.position.z);
      else return false;
      projected.project(camera);
      if (projected.z < -1 || projected.z > 1) return false;
      out.x = (projected.x * 0.5 + 0.5) * viewport.w;
      out.y = (0.5 - projected.y * 0.5) * viewport.h;
      return true;
    };

    // ---- The pickable set ---------------------------------------------------
    //
    // The disk holds tens of thousands of stations and a pointer can only tell
    // neighbours apart when their centres are far enough apart on screen. The
    // disk is therefore picked against a small subset: on screen, the biggest
    // in their 18 px cell, capped by a budget that falls when frames get slow.
    // Everything outside it still glows; it is simply not a target.
    //
    // The cluster is NOT narrowed. There every star is a deliberate target and
    // a click selects rather than plays, so that path keeps the full scan.
    const PICKABLE_CELL = 18;
    const PICKABLE_BUDGETS = [320, 240, 180, 120];
    const PICKABLE_REFRESH_MS = 100;
    const PICKABLE_MIN_RADIUS = 10;
    let pickableLevel = 0;
    let pickableAt = -Infinity;
    let pickableKey = NaN;
    let pickableBuilt = false;
    let pickLevelAt = 0;
    const pickableIndexes = [];
    const pickableCells = new Set();
    const pickableTiers = [[], [], [], []];
    const screenX = new Float32Array(stations.length);
    const screenY = new Float32Array(stations.length);
    const screenPoint = { x: 0, y: 0 };

    const rebuildPickable = () => {
      pickableIndexes.length = 0;
      pickableCells.clear();
      for (let tier = 0; tier < 4; tier += 1) pickableTiers[tier].length = 0;
      pickableAt = performance.now();
      pickableBuilt = true;
      if (!layer) return;
      const budget = PICKABLE_BUDGETS[pickableLevel];
      const w = viewport.w;
      const h = viewport.h;
      // One projection pass, bucketed by on-screen size, so that in the greedy
      // pass below the biggest target wins its cell rather than whichever one
      // happened to be visited first.
      for (let index = 0; index < stations.length; index += 1) {
        if (!layer.interactive(index)) continue;
        if (!projectScreenInto(index, screenPoint)) continue;
        const x = screenPoint.x;
        const y = screenPoint.y;
        if (x < -24 || y < -24 || x > w + 24 || y > h + 24) continue;
        screenX[index] = x;
        screenY[index] = y;
        const size = layer.screenSizeAt(index, camera, h);
        const tier = size >= 24 ? 3 : size >= 16 ? 2 : size >= 10 ? 1 : 0;
        pickableTiers[tier].push(index);
      }
      for (let tier = 3; tier >= 0; tier -= 1) {
        const bucket = pickableTiers[tier];
        for (let n = 0; n < bucket.length; n += 1) {
          const index = bucket[n];
          const cx = Math.floor(screenX[index] / PICKABLE_CELL);
          const cy = Math.floor(screenY[index] / PICKABLE_CELL);
          const key = cy * 8192 + cx;
          if (pickableCells.has(key)) continue;
          pickableCells.add(key);
          pickableIndexes.push(index);
          if (pickableIndexes.length >= budget) return;
        }
      }
    };

    /**
     * A cheap pose signature. Screen coordinates only stay valid while the
     * camera, the viewport and the anchors do, so a change in any of them has
     * to rebuild even inside the throttle window. A category reveal moves the
     * whole layer without touching the camera, which is why the layer hands out
     * its own layout generation.
     */
    const cameraSignature = () => {
      const p = camera.position;
      const q = camera.quaternion;
      const layout = layer && typeof layer.layoutVersion === 'function' ? layer.layoutVersion() : 0;
      return p.x * 3 + p.y * 7 + p.z * 11
        + q.x * 13 + q.y * 17 + q.z * 19 + q.w * 23
        + viewport.w * 29 + viewport.h * 31 + layout * 37;
    };

    const refreshPickable = () => {
      // The disc no longer projects stations: it reads the answer back from the
      // raster that drew the pixel. So the projected grid is only ever built
      // for a space that still picks by projection.
      if (machine.progress < 0.5) return;
      const now = performance.now();
      if (now - pickableAt < PICKABLE_REFRESH_MS) return;
      const signature = cameraSignature();
      // An empty set is a valid result, so the flag -- not the length -- says
      // whether there is anything to keep.
      if (pickableBuilt && signature === pickableKey) return;
      pickableKey = signature;
      rebuildPickable();
    };

    const pickCluster = (px, py) => {
      let best = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < stations.length; index += 1) {
        if (!layer.interactive(index)) continue;
        const p = projectStation(index);
        if (!p) continue;
        const size = layer.screenSizeAt(index, camera, viewport.h);
        // In the cluster a click has to resolve one star among a dense core, so
        // the radius grows a little; it still cannot reach a neighbour's centre.
        const threshold = Math.max(9, Math.min(34, size * 1.15 + 8));
        const distance = Math.hypot(p.x - px, p.y - py);
        if (distance <= threshold && distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return best;
    };

    /**
     * Resolve a screen point to the station whose matter lit that pixel.
     *
     * The imaging pass already knows the answer: it samples the station raster
     * at every crossing, so the same render that drew the pixel carries the
     * index of the station that produced it. Reading that back makes the hit
     * test and the picture the same object — they cannot drift apart, and no
     * projected geometry has to agree with the lensing.
     *
     * @returns {number} station index, or -1 when the pixel is background
     */
    const stationIndexAt = (px, py) => {
      if (drawingBuffer.x <= 0 || drawingBuffer.y <= 0) return -1;
      const frameX = (px / Math.max(1, viewport.w)) * drawingBuffer.x;
      // The frame's origin is bottom-left; the pointer's is top-left.
      const frameY = ((viewport.h - py) / Math.max(1, viewport.h)) * drawingBuffer.y;
      const x = Math.min(drawingBuffer.x - 1, Math.max(0, Math.floor(frameX)));
      const y = Math.min(drawingBuffer.y - 1, Math.max(0, Math.floor(frameY)));
      const read = disk.probe({
        mode: 65,
        region: { x, y, width: 1, height: 1 },
        unpack: 'fast',
      });
      if (!read) return -1;
      const value = Math.round(Number(read.data[0]));
      if (!Number.isFinite(value) || value < 0) return -1;
      return value < stations.length ? value : -1;
    };

    /**
     * Resolve a screen point to a station.
     *
     * The disc answers from its own density raster. A cluster keeps the full
     * scan, because there every star is meant to be reachable and nothing is
     * occluded by a disc.
     */
    const pick = (clientX, clientY) => {
      if (!layer) return -1;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      if (px < 0 || py < 0 || px > viewport.w || py > viewport.h) return -1;
      // While the hole is visible its centre is a control, not a station. Once
      // the cluster owns the frame there is no hole and therefore no keep-out.
      if (machine.progress < 0.4) {
        const hole = silhouette();
        if (Math.hypot(px - hole.x, py - hole.y) < hole.r * 0.98) return -1;
      }
      if (machine.progress > 0.5) return pickCluster(px, py);
      return stationIndexAt(px, py);
    };

    // ---- The hovered station ------------------------------------------------
    //
    // The stage reports what the pointer is over; it does not decide when a card
    // appears. The panel owns that timing, so the same report can drive a card,
    // a label suppression and a touch long-press without a second source.
    let hoverIndex = -1;

    /**
     * Is the pointer over the disc's band?
     *
     * The pointer freezes the record while it is over the disc's band, not only
     * while a station is directly under it: the stations are laid over the whole
     * disc, so pinning on a hit alone made the band stop and start at every seam
     * between two stations.
     *
     * The band is measured where the disc actually is — matter in the y = 0
     * plane — so the pointer's ray is intersected with that plane and the hit is
     * held against the disc's own radii. A screen-space circle cannot do this:
     * the camera sits a few degrees above the disc plane, so the rim projects to
     * an ellipse far flatter than it is wide, and a circle around the hole
     * swallows most of the empty sky above and below the rim. The shadow is
     * excluded first, because it is a control rather than disc matter: resting
     * on it must leave the record turning.
     *
     * @param px - pointer x in CSS pixels inside the canvas
     * @param py - pointer y in CSS pixels inside the canvas
     */
    const pointerOverDisc = (px, py) => {
      const hole = silhouette();
      const toShadowX = px - hole.x;
      const toShadowY = py - hole.y;
      if (toShadowX * toShadowX + toShadowY * toShadowY < hole.r * hole.r) return false;
      pointerRay
        .set((px / Math.max(1, viewport.w)) * 2 - 1, 1 - (py / Math.max(1, viewport.h)) * 2, 0.5)
        .unproject(camera)
        .sub(camera.position);
      // A ray that runs along the disc plane never meets it, and one that leaves
      // away from it meets it behind the camera: both are off the disc.
      if (!(Math.abs(pointerRay.y) > 1e-6)) return false;
      const travel = (holeCenter.y - camera.position.y) / pointerRay.y;
      if (!(travel > 0)) return false;
      const hitX = camera.position.x + pointerRay.x * travel - holeCenter.x;
      const hitZ = camera.position.z + pointerRay.z * travel - holeCenter.z;
      const reach = Math.hypot(hitX, hitZ);
      return reach >= DISK_INNER && reach <= DISK_OUTER;
    };

    /** The pointer is somewhere on the disc's band, clear of the hole. */
    let pauseHeld = false;
    /** The panel reports the pointer on the hover card, which counts as inside. */
    let cardHeld = false;
    /**
     * The search box is open. Typing is not pinning a station, so a pointer
     * resting over the disc must not freeze it for as long as the box is up.
     */
    let searchHeld = false;

    /**
     * Freeze or resume the record for the two reasons that can hold it: the
     * pointer over the disc's band, or the pointer on the card that freeze
     * produced. Resuming waits out the card's own dismissal, so carrying the
     * pointer from a station onto its card does not set the band turning again
     * underneath someone who is about to click the card.
     */
    const syncSpin = () => {
      if (!disk || typeof disk.setStationSpin !== 'function') return;
      if (spinTimer) {
        clearTimeout(spinTimer);
        spinTimer = 0;
      }
      if (pauseHeld || cardHeld) {
        disk.setStationSpin(0);
      } else {
        spinTimer = setTimeout(() => {
          spinTimer = 0;
          disk.setStationSpin(1);
          dirty = true;
          requestFrame();
        }, 240);
      }
      dirty = true;
      requestFrame();
    };

    const holdSpin = (value) => {
      const next = Boolean(value);
      if (pauseHeld === next) return;
      pauseHeld = next;
      syncSpin();
    };

    /** Freeze or resume the record for a pointer position in client pixels. */
    const trackDiscRegion = (clientX, clientY) => {
      if (searchHeld || !canOpenCenter() || lastPointerType === 'touch') {
        holdSpin(false);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      holdSpin(pointerOverDisc(clientX - rect.left, clientY - rect.top));
    };

    // A card opened by a touch press has no pointer hovering it: the finger is
    // gone before the card is read. Such a card survives a pointerleave and is
    // dismissed by the next press instead.
    let hoverSticky = false;
    /**
     * Resuming is delayed past the card's own dismissal, so carrying the pointer
     * from the disc onto the card does not start the record turning again
     * underneath a reader who is about to click the card.
     */
    let spinTimer = 0;

    const emitHover = (index, clientX, clientY) => {
      const station = index >= 0 ? stations[index] : null;
      if (index === hoverIndex) return;
      hoverIndex = index;
      // The panel's card names the station; the sky only steps its own caption
      // aside, which is a redraw either way.
      if (layer) layer.setHoverIndex(hoverIndex);
      hoverSticky = Boolean(station) && lastPointerType === 'touch';
      dirty = true;
      requestFrame();
      if (typeof settings.onHover !== 'function') return;
      try {
        settings.onHover(
          station
            ? {
                index,
                station,
                x: clientX,
                y: clientY,
                touch: lastPointerType === 'touch',
              }
            : null,
        );
      } catch {
        /* a panel bug must not break the render loop */
      }
    };

    const clearHover = () => {
      if (hoverIndex < 0) return;
      emitHover(-1, 0, 0);
    };

    /**
     * Play (or pause) the station under a click.
     *
     * Selecting alongside keeps the side panel and the marker honest, but the
     * camera is never moved: a click on the disk is transport, not navigation.
     */
    const playStation = (index) => {
      const station = stations[index];
      if (!station) return;
      clearRadioSelection();
      select(index, { focus: false, notify: true });
      if (typeof settings.onPlay !== 'function') return;
      try {
        settings.onPlay(station, index);
      } catch {
        /* ignore */
      }
    };

    // ---- Fixture imaging probes --------------------------------------------
    //
    // A fixture's screen position is not a projection of its world position.
    // Light from a source at 2.6 b_crit near the hole is bent on its way out, so
    // the pixel that shows it is where the *trace* says the ray came from. The
    // stage therefore asks the shader that draws the picture, through the id
    // channel: probe mode 26 returns the visible fixture id, 27 the trace's table
    // slot, 33 the crossing index in physical order along the ray, 32 the visible
    // luminance. The anchor, the label and the click target all come from that one
    // read, so they cannot disagree.
    //
    // `branch` in the public anchor is the crossing index (1 = first plane
    // crossing along the ray, 2 = second). The table slot is carried alongside it
    // and is NOT a physical order: a ray that crosses the plane once can still be
    // solved by the table's second branch, which is exactly what the far-side
    // fixture does (slot 2, crossing 1).

    const radioIdAt = (frameX, frameY) => {
      const x = Math.min(drawingBuffer.x - 1, Math.max(0, Math.floor(frameX)));
      const y = Math.min(drawingBuffer.y - 1, Math.max(0, Math.floor(frameY)));
      const read = disk.probe({
        mode: 26,
        region: { x, y, width: 1, height: 1 },
        unpack: 'fast',
      });
      if (!read) return null;
      const gpuId = Math.round(read.data[0]);
      if (!gpuId) return null;
      const slotRead = disk.probe({
        mode: 27,
        region: { x, y, width: 1, height: 1 },
        unpack: 'fast',
      });
      const crossingRead = disk.probe({
        mode: 33,
        region: { x, y, width: 1, height: 1 },
        unpack: 'fast',
      });
      const slot = slotRead ? Math.round(slotRead.data[0]) || 0 : 0;
      const crossingIndex = crossingRead ? Math.round(crossingRead.data[0]) || 1 : 1;
      return { gpuId, slot, branch: crossingIndex, frameX: x, frameY: y };
    };

    /** Connected regions of one id inside a packed id read. */
    const radioComponents = (data, width, height, gpuId) => {
      const seen = new Uint8Array(width * height);
      // Per-column pixel counts for one component at a time, stamped so a new
      // component does not have to clear the whole row.
      const colCount = new Uint16Array(width);
      const colStamp = new Uint32Array(width);
      let stamp = 0;
      const out = [];
      const matches = (x, y) => {
        if (x < 0 || y < 0 || x >= width || y >= height) return -1;
        const index = y * width + x;
        if (seen[index]) return -1;
        return Math.round(data[index]) === gpuId ? index : -1;
      };
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const start = matches(x, y);
          if (start < 0) continue;
          stamp += 1;
          const stack = [start];
          const pixels = [];
          seen[start] = 1;
          let count = 0;
          let cols = 0;
          let sumX = 0;
          let sumY = 0;
          let minX = x;
          let maxX = x;
          let minY = y;
          let maxY = y;
          while (stack.length) {
            const at = stack.pop();
            const px = at % width;
            const py = (at - px) / width;
            count += 1;
            pixels.push(at);
            sumX += px + 0.5;
            sumY += py + 0.5;
            if (colStamp[px] === stamp) colCount[px] += 1;
            else {
              colStamp[px] = stamp;
              colCount[px] = 1;
              cols += 1;
            }
            if (px < minX) minX = px;
            if (px > maxX) maxX = px;
            if (py < minY) minY = py;
            if (py > maxY) maxY = py;
            // 8-connectivity: a strip one pixel thick and steep is a diagonal
            // line, and 4-connectivity shreds it into single-pixel islands.
            const neighbours = [
              matches(px - 1, py - 1),
              matches(px, py - 1),
              matches(px + 1, py - 1),
              matches(px - 1, py),
              matches(px + 1, py),
              matches(px - 1, py + 1),
              matches(px, py + 1),
              matches(px + 1, py + 1),
            ];
            for (const next of neighbours) {
              if (next < 0) continue;
              seen[next] = 1;
              stack.push(next);
            }
          }
          // Thickness: pixels per occupied column, i.e. how deep the image is in
          // the direction the strip is thin. The longest single-column run is not
          // it: where the near-axis cap turns steeply one column holds four rows,
          // and the bounding box (17 px tall) would call a 1 px strip a blob.
          let thickness = count;
          let maxRun = 1;
          if (cols > 0) thickness = count / cols;
          for (const at of pixels) {
            const px = at % width;
            if (colStamp[px] === stamp && colCount[px] > maxRun) maxRun = colCount[px];
          }
          const cx = sumX / count;
          const cy = sumY / count;
          // A component's centroid can land outside it — an arc is hollow — and
          // a hit test at the centroid would then miss the very image it
          // measures. Keep the pixel nearest the centroid as the representative
          // point that the id read and the click test use.
          let repX = x;
          let repY = y;
          let best = Infinity;
          for (const at of pixels) {
            const px = at % width;
            const py = (at - px) / width;
            const d = (px + 0.5 - cx) * (px + 0.5 - cx) + (py + 0.5 - cy) * (py + 0.5 - cy);
            if (d < best) {
              best = d;
              repX = px;
              repY = py;
            }
          }
          out.push({ count, x: cx, y: cy, repX, repY, thickness, maxRun, minX, maxX, minY, maxY });
        }
      }
      return out;
    };

    /**
     * Locate every enabled fixture: coarse id sweep over the whole frame, then a
     * full-resolution refinement around each blob, because the disc is seen at
     * 2.8 degrees and a circular patch is a strip 0.3-0.8 px thick radially.
     */
    const scanRadioAnchors = () => {
      if (!radio || disposed) return [];
      // Native resolution, one read. A coarse sweep was tried and rejected: the
      // id is coverage-filtered with fwidth, so at 1/4 resolution a 0.6 px strip
      // smears into a blob wide enough to refine onto a neighbouring source.
      // 1280x720 readback costs one frame's worth of work, and only when the
      // camera moved or the field drifted.
      const read = disk.probe({
        mode: 26,
        width: drawingBuffer.x,
        height: drawingBuffer.y,
        unpack: 'fast',
      });
      if (!read) return [];
      const anchors = [];
      for (const fixture of radioFixtures) {
        const blobs = radioComponents(read.data, read.width, read.height, fixture.gpuId);
        for (const blob of blobs) {
          // Read the id at a pixel that is actually inside the component: an
          // arc's centroid sits in its hollow, and gating on it threw the whole
          // arc away and kept only the stray single pixels.
          const hit = radioIdAt(blob.repX, blob.repY);
          if (!hit || hit.gpuId !== fixture.gpuId) continue;
          // The pixel centroid of a binary id set is not continuous under camera
          // motion: a 0.30 px thick image straddles two rows, and as the camera
          // creeps the row that clears the attribution threshold flips, which
          // moves the centroid by the along-image offset between those rows
          // (measured: a 4.2 px jump over 0.2 degrees of orbit — and weighting
          // only the id pixels does not help, because the flip changes WHICH
          // pixels are in the set). Weight the emitter's AREA coverage instead:
          // the fraction of each pixel's footprint the patch covers, an integral
          // of the geometry, continuous under camera motion. It is read over the
          // component's bounding box widened by two pixels, with no id filter, so
          // the window contains the whole image on both sides of a row flip and
          // its own edges move through the field's low tail (weight ~0.05 against
          // a total of order 1.5).
          const pad = 2;
          const cov = disk.probe({
            mode: 62,
            region: {
              x: Math.max(0, blob.minX - pad),
              y: Math.max(0, blob.minY - pad),
              width: Math.min(read.width, blob.maxX + pad + 1) - Math.max(0, blob.minX - pad),
              height: Math.min(read.height, blob.maxY + pad + 1) - Math.max(0, blob.minY - pad),
            },
            unpack: 'fast',
            // Slot bit, not the filtered index: the probe renders with this mask
            // and the id it isolates must be the same fixture the component was
            // found for. Using the filtered index isolated a neighbour whenever
            // the enabled subset was not a prefix of the suite.
            radioMask: radioMaskBit(fixture.businessId),
          });
          const covX0 = Math.max(0, blob.minX - pad);
          const covY0 = Math.max(0, blob.minY - pad);
          let wx = 0;
          let wy = 0;
          let wsum = 0;
          if (cov) {
            for (let ry = 0; ry < cov.height; ry += 1) {
              for (let rx = 0; rx < cov.width; rx += 1) {
                // unpack:'fast' returns one float32 per pixel, not four bytes.
                const w = cov.data[ry * cov.width + rx];
                if (!(w > 0)) continue;
                wx += (covX0 + rx + 0.5) * w;
                wy += (covY0 + ry + 0.5) * w;
                wsum += w;
              }
            }
          }
          const anchorX = wsum > 0 ? wx / wsum : blob.x;
          const anchorY = wsum > 0 ? wy / wsum : blob.y;
          anchors.push({
            businessId: fixture.businessId,
            gpuId: fixture.gpuId,
            kind: fixture.kind,
            label: fixture.label[labelLanguage] || fixture.label.zh,
            branch: hit.branch,
            slot: hit.slot,
            frameX: anchorX,
            frameY: anchorY,
            // CSS pixels, top-left origin: same space as pointer events.
            x: (anchorX / read.width) * viewport.w,
            y: viewport.h - (anchorY / read.height) * viewport.h,
            // The pixel a click must land on: the component's nearest pixel to
            // its centroid, so a hollow image is still hit-testable.
            pickX: ((blob.repX + 0.5) / read.width) * viewport.w,
            pickY: viewport.h - ((blob.repY + 0.5) / read.height) * viewport.h,
            pixels: blob.count,
            thicknessPx: (blob.thickness / read.height) * viewport.h,
            maxRunPx: (blob.maxRun / read.height) * viewport.h,
            minXPx: (blob.minX / read.width) * viewport.w,
            maxXPx: ((blob.maxX + 1) / read.width) * viewport.w,
            minYPx: viewport.h - ((blob.maxY + 1) / read.height) * viewport.h,
            maxYPx: viewport.h - (blob.minY / read.height) * viewport.h,
            widthPx: ((blob.maxX - blob.minX + 1) / read.width) * viewport.w,
            heightPx: ((blob.maxY - blob.minY + 1) / read.height) * viewport.h,
          });
        }
      }
      // One image, one anchor per (source, branch). A strip thinner than a
      // pixel breaks where the crossing passes between rows, so the largest
      // fragment is the image and the rest are recorded as extras rather than
      // dropped. Fragments tens of pixels away are higher-order images near the
      // critical curve: merging them would stretch one anchor's box across
      // dozens of rows and turn a 3 px strip into a 44 px blob.
      const byImage = new Map();
      const extras = [];
      for (const anchor of anchors) {
        const key = `${anchor.businessId}#${anchor.branch}`;
        const near = byImage.get(key);
        if (!near) {
          byImage.set(key, anchor);
          continue;
        }
        if (anchor.pixels > near.pixels) {
          extras.push(near);
          byImage.set(key, anchor);
        } else {
          extras.push(anchor);
        }
      }
      radioState.extras = extras;
      const merged = [...byImage.values()];
      merged.sort((a, b) => (a.businessId === b.businessId ? a.branch - b.branch : a.businessId < b.businessId ? -1 : 1));
      return merged;
    };

    const radioCameraKey = () => {
      const p = camera.position;
      const q = camera.quaternion;
      return [
        p.x.toFixed(4),
        p.y.toFixed(4),
        p.z.toFixed(4),
        q.x.toFixed(5),
        q.y.toFixed(5),
        q.z.toFixed(5),
        q.w.toFixed(5),
        camera.fov.toFixed(3),
        `${drawingBuffer.x}x${drawingBuffer.y}`,
      ].join(',');
    };

    /**
     * Re-anchor when the view changed or a couple of hundred milliseconds went
     * by (the field drifts with retarded time), then paint the labels.
     */
    const updateRadioOverlay = () => {
      if (!radio) return;
      const now = performance.now();
      const key = radioCameraKey();
      const due = radioState.stale || key !== radioState.cameraKey || now - radioState.lastScan > 240;
      if (due) {
        radioState.anchors = scanRadioAnchors();
        radioState.cameraKey = key;
        radioState.lastScan = now;
        radioState.frameVersion += 1;
        radioState.stale = false;
      }
      radio.draw({
        anchors: radioState.anchors,
        selectedBusinessId: radioState.selectedId,
        selectedBranch: radioState.selectedBranch,
      });
    };

    const selectRadio = (businessId, branch) => {
      if (!radio) return false;
      const fixture = radioFixtures.find((item) => item.businessId === businessId);
      if (!fixture) return false;
      radioState.selectedId = businessId;
      radioState.selectedBranch = Number(branch) || 0;
      // One selection at a time: a fixture is not a catalogue station.
      if (selectedIndex >= 0) {
        selectedIndex = -1;
        selectedId = null;
        syncDataset();
      }
      radioState.stale = true;
      dirty = true;
      requestFrame();
      return true;
    };

    const clearRadioSelection = () => {
      if (!radioState.selectedId) return false;
      radioState.selectedId = null;
      radioState.selectedBranch = 0;
      dirty = true;
      return true;
    };

    /**
     * Pixel-exact fixture hit test. The probe reads the id channel at the one
     * pixel under the pointer, so a click agrees with the colour the user sees
     * and never with a bounding box.
     */
    const pickRadio = (clientX, clientY) => {
      if (!radio) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const cssX = clientX - rect.left;
      const cssY = clientY - rect.top;
      if (cssX < 0 || cssY < 0 || cssX > viewport.w || cssY > viewport.h) return null;
      const frameX = (cssX / viewport.w) * drawingBuffer.x;
      const frameY = ((viewport.h - cssY) / viewport.h) * drawingBuffer.y;
      const hit = radioIdAt(frameX, frameY);
      if (!hit) return null;
      const fixture = fixtureByGpuId(hit.gpuId);
      if (!fixture) return null;
      const anchor = radioState.anchors.find(
        (item) => item.gpuId === hit.gpuId && item.branch === hit.branch,
      );
      return {
        businessId: fixture.businessId,
        gpuId: fixture.gpuId,
        branch: hit.branch,
        pixel: { x: hit.frameX, y: hit.frameY },
        css: { x: cssX, y: cssY },
        anchor: anchor ? { x: anchor.x, y: anchor.y } : null,
        frameVersion: radioState.frameVersion,
        cameraKey: radioState.cameraKey,
      };
    };

    const syncDataset = () => {
      // The crossing, for the real-engine probe: the CPU harness cannot see a
      // leg that gets stranded, and the canvas is where the scene already
      // publishes what it is.
      canvas.setAttribute('data-bhrl-crossing', worm.kind || '');
      if (selectedId) canvas.setAttribute('data-bhrl-selected', selectedId);
      else canvas.removeAttribute('data-bhrl-selected');
      canvas.setAttribute('data-bhrl-mode', machine.mode);
    };

    const emitSelect = (station) => {
      if (typeof settings.onSelect !== 'function') return;
      try {
        settings.onSelect(station || null);
      } catch {
        /* a panel bug must not break the render loop */
      }
    };

    const notifyMode = () => {
      const snapshot = stateSnapshot();
      const key = `${snapshot.state}|${snapshot.categoryId || ''}|${snapshot.transitioning ? 1 : 0}`;
      if (key === lastModeKey) return;
      lastModeKey = key;
      canvas.setAttribute('data-bhrl-state', snapshot.state);
      if (typeof settings.onMode !== 'function') return;
      try {
        settings.onMode(snapshot);
      } catch {
        /* ignore */
      }
    };

    const stateSnapshot = () => {
      const state = transitioning
        ? machine.target > 0.5
          ? 'transition-to-cluster'
          : 'transition-to-black-hole'
        : machine.mode === 'cluster'
          ? 'cluster'
          : machine.ui;
      return {
        state,
        mode: machine.mode,
        ui: machine.ui,
        categoryId: machine.categoryId,
        progress: Math.round(machine.progress * 1000) / 1000,
        // How much of the cluster space is present. Kept under its phase-1 name
        // so the panel contract does not have to follow the scene's internals.
        tc: Math.round(smoothstep01(machine.progress) * 1000) / 1000,
        transitioning,
        crossing: worm.kind
          ? { kind: worm.kind, target: worm.target || null, locked: Boolean(worm.locked) }
          : null,
        stations: stations.length,
        genres: genres.length,
      };
    };

    const setUi = (ui) => {
      const next = ui === 'search' ? ui : 'black-hole';
      if (machine.ui === next) return;
      machine.ui = next;
      clearTimers();
      notifyMode();
    };

    /** Stop every pending long-press timer. Called on mode changes. */
    const clearTimers = () => {
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      // The record's own resume timer belongs to the scene too: left behind, it
      // fires against a disposed disk when the page changes mid-freeze. Resuming
      // here is the same thing the timer would have done, minus the wait.
      if (spinTimer) {
        clearTimeout(spinTimer);
        spinTimer = 0;
        if (!pauseHeld && !cardHeld && disk && typeof disk.setStationSpin === 'function') disk.setStationSpin(1);
      }
    };

    const select = (index, selectOptions) => {
      const opts = selectOptions || {};
      if (!layer || !Number.isInteger(index) || index < 0 || index >= stations.length) return false;
      const station = stations[index];
      selectedIndex = index;
      selectedId = station.id;
      layer.setSelectedIndex(index);
      if (opts.focus !== false) {
        layer.positionInto(index, focusTarget);
        const distance = machine.mode === 'cluster' ? (station.isFeatured ? 2.8 : 2.35) : station.isFeatured ? 7.0 : 6.4;
        rig.focusOn(focusTarget, { distance });
      }
      syncDataset();
      dirty = true;
      requestFrame();
      if (opts.notify !== false) emitSelect(station);
      return true;
    };

    const clearSelection = (notify) => {
      const hadSelection = selectedIndex >= 0 || Boolean(selectedId);
      if (rig.framing().mode === 'focus') rig.reset();
      if (!hadSelection) return;
      selectedIndex = -1;
      selectedId = null;
      if (layer) layer.setSelectedIndex(-1);
      syncDataset();
      dirty = true;
      requestFrame();
      if (notify !== false) emitSelect(null);
    };

    /**
     * Enter the cluster of one category. Safe to call during the opposite
     * transition: it replaces the destination and lets the same progress value
     * turn round from wherever it is.
     */
    const enterCluster = (categoryId) => {
      // The cluster page is the whole vocabulary field: every category has its
      // own group and its own fixed berth, so there is no single category to
      // enter. `categoryId` is accepted for the search path, which only needs
      // the field to exist before it focuses a station inside it.
      if (!layer) return false;
      if (machine.mode === 'cluster' && machine.target === 1) return true;
      let layout = layoutCache.get('field');
      if (!layout) {
        layout = buildClusterLayout(stations, { seed: catalog.seed, vocabulary: GENRE_IDS, byGenre: true, forms: true });
        layoutCache.set('field', layout);
      }
      if (machine.mode !== 'cluster' && machine.target < 0.5) {
        machine.savedCamera = rig.framing();
        // The scene drops its own highlight — the station has no berth in the
        // field — but the host keeps the choice: the sidebar card and the
        // info panel describe what the listener picked, not what this scene
        // happens to draw. Notifying here is what emptied the card on entry.
        clearSelection(false);
      }
      clearTimers();
      machine.categoryId = categoryId ? String(categoryId) : null;
      machine.layout = layout;
      machine.ui = 'black-hole';
      machine.target = 1;
      if (machine.progress > 0.999) machine.progress = 0.999;
      transitioning = true;
      layer.setCluster(layout);
      // The space does not change hands: the field forms where the hole was, so
      // the camera keeps the framing and the angles it already had and only the
      // orbit range is widened to cover the field. Swapping the home here is
      // what made the crossing read as a jump between two rooms.
      const framing = rig.framing();
      const here = framing && Number.isFinite(framing.radius) ? framing.radius : layout.camera.radius;
      rig.setHome({
        radius: here,
        phi: framing && Number.isFinite(framing.phi) ? framing.phi : undefined,
        theta: framing && Number.isFinite(framing.theta) ? framing.theta : undefined,
        minRadius: Math.min(layout.minRadius, here),
        maxRadius: Math.max(layout.maxRadius, here * 2),
      });
      applyTransition();
      dirty = true;
      requestFrame();
      notifyMode();
      return true;
    };

    /**
     * Return to the hole. `options.focusId` focuses a station once the hole is
     * back, which is how a cross-mode search result is honoured: enter the
     * scene that contains the station first, then focus — never a cut.
     */
    const exitCluster = (exitOptions) => {
      const opts = exitOptions || {};
      if (!layer) return false;
      if (machine.target === 0 && machine.mode === 'black-hole') {
        if (opts.focusId) focusOrSelect(opts.focusId);
        return true;
      }
      clearTimers();
      clearSelection(false);
      machine.pendingFocus = opts.focusId ? String(opts.focusId) : null;
      machine.target = 0;
      if (machine.progress < 0.001) machine.progress = 0.001;
      transitioning = true;
      layer.setCluster(null);
      const saved = machine.savedCamera;
      const limits = holeOrbitLimits();
      rig.setHome({
        radius: saved && saved.radius ? saved.radius : undefined,
        phi: saved && saved.phi ? saved.phi : undefined,
        theta: saved && Number.isFinite(saved && saved.theta) ? saved.theta : undefined,
        minRadius: limits.minRadius,
        maxRadius: limits.maxRadius,
      });
      applyTransition();
      dirty = true;
      requestFrame();
      notifyMode();
      return true;
    };

    const finishTransition = () => {
      transitioning = false;
      if (machine.target > 0.5) {
        machine.mode = 'cluster';
        machine.ui = 'black-hole';
        const pendingCluster = machine.pendingClusterFocus;
        machine.pendingClusterFocus = null;
        if (pendingCluster) {
          const index = idToIndex.get(String(pendingCluster));
          if (index !== undefined) {
            requestAnimationFrame(() => {
              if (!disposed) select(index, { focus: true, notify: true });
            });
          }
        }
      } else {
        machine.mode = 'black-hole';
        machine.categoryId = null;
        machine.layout = null;
        machine.ui = 'black-hole';
        const pending = machine.pendingFocus;
        machine.pendingFocus = null;
        if (pending) {
          requestAnimationFrame(() => {
            if (!disposed) focusOrSelect(pending);
          });
        }
      }
      syncDataset();
      notifyMode();
    };

    /**
     * The cross-mode locate path. A member of the active cluster is selected
     * directly; anything else exits to the hole first and focuses afterwards.
     */
    const focusOrSelect = (id) => {
      const index = idToIndex.get(String(id));
      if (index === undefined) return false;
      const station = stations[index];
      const primary = (station.metadata && station.metadata.primaryCategory) || station.categories[0];
      const inCluster = machine.mode === 'cluster' || machine.progress > 0.25;
      // A result from another category is reached by entering *its* scene, then
      // focusing. The camera never cuts across a hidden layout.
      if (inCluster && primary && machine.categoryId !== primary) {
        machine.pendingClusterFocus = String(id);
        if (enterCluster(primary)) return true;
        machine.pendingClusterFocus = null;
      }
      if (inCluster && machine.layout && machine.layout.members[index] !== 1) {
        exitCluster({ focusId: id });
        return true;
      }
      return select(index, { focus: true, notify: true });
    };

    // ---- the wormhole hold ------------------------------------------------
    //
    // One hold machine for both directions. `kind` says which way the frame is
    // being pushed ('enter' from the hole, 'exit' from the cluster), `startedAt`
    // is a wall clock reading so a slow frame shortens the wait instead of
    // stretching it, and `locked` is the point of no return: before it a release
    // cancels, after it the timeline runs to the end.
    //
    // The fall starts on the press, not on the lock: the shadow widens from the
    // first frame, and the ring is only the countdown drawn beside the cursor.
    // That means a cancel has something to give back, which is the recoil: a
    // short damped retreat over the phase that was on screen at the release.
    // It is not a rewind of the timeline — only that one phase interpolates —
    // so nothing half applied is left behind when it lands.

    const worm = {
      kind: null,
      locked: false,
      startedAt: 0,
      downX: 0,
      downY: 0,
      cursorX: 0,
      cursorY: 0,
      /** The pointer that owns the hold: only that one may cancel it. */
      pointerId: -1,
      /**
       * The button it was opened with. Both buttons share a pointerId, so this
       * is what keeps a stray opposite click from cancelling somebody else's
       * hold. Touch reports 0 and is matched against 0.
       */
      button: 0,
      /** How opaque the mask is right now, for the layers drawn above it. */
      alpha: 0,
      /** When the page lost focus mid-hold, so the clock can be given back. */
      hiddenAt: 0,
      /** One-off guards, so a threshold can fire only once per hold. */
      covered: false,
      veiled: false,
      /** The last phase handed to the mask, so a cancel can retreat from it. */
      phase: null,
      /** Where a retreat started from: the phase on screen at the cancel. */
      from: null,
      /** Wind-up on screen when the hold was cancelled, so a new press resumes it. */
      charge: 0,
      /** Gathering already under way, so a cancel can slide it home. */
      blend: 0,
      layoutReady: false,
      landed: false,
      /** The crossing finished inside its own frame: the tick fills the ring. */
      pulseEnd: false,
      landedLeg: null,
      /**
       * The exit has run its one-time preparation (the disc capture, the space
       * hand-over) but the crossing is not committed yet: the lock comes only
       * when the ring is full, so a release in between has to put the cluster
       * back.
       */
      armed: false,
      /** An exit was released after it armed: finish the give-back next frame. */
      settling: false,
      /** The 0.6 s "held long enough to count" pulse already fired this press. */
      pulsed: false,
      /** Where a cancel retreats to: 0 back to the hole, 1 back to the cluster. */
      recoilTarget: 0,
      /** Blend on screen when an exit was cancelled, so the retreat is sized. */
      recoilBlend: 0,
      /** Cluster blend when the exit was armed: a cancel before it settles resumes. */
      progressBefore: 0,
      /** The ring reached its full arc and was dismissed for this hold. */
    };

    const ringPoint = (event) => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const prepareDiscTransfer = (options) => {
      let field = layoutCache.get('field');
      if (!field) {
        field = buildClusterLayout(stations, { seed: catalog.seed, vocabulary: GENRE_IDS, byGenre: true, forms: true });
        layoutCache.set('field', field);
      }
      if (!reducedMotion && !discTransfer.active) {
        // Exit reconstructs the SAVED hole view, not a screenshot taken from a
        // focused cluster camera. The rig eases toward this same framing.
        let sourceCamera = camera;
        const framing = options && options.holeFraming;
        if (framing) {
          sourceCamera = camera.clone();
          const center = framing.target || { x: 0, y: 0, z: 0 };
          sourceCamera.position.setFromSphericalCoords(framing.radius, framing.phi, framing.theta);
          sourceCamera.position.add(new Vector3(center.x, center.y, center.z));
          sourceCamera.lookAt(center.x, center.y, center.z);
          sourceCamera.updateMatrixWorld();
        }
        try {
          // Capture/build first; install the driven layout only after success.
          // A readback failure must not strand an ownerless flow=0 layer.
          disk.update(elapsed, sourceCamera);
          discTransfer.begin(disk.captureDisc(sourceCamera), field);
        } catch (error) {
          discTransfer.end();
          disk.setDiscTransfer(-1);
          console.warn('Black Hole Radio: disc transfer capture failed', describe(error));
          return false;
        } finally {
          disk.update(elapsed, camera);
        }
        disk.setStationSpin(0);
      }
      layer.setCluster(field);
      layer.setFlow(discTransfer.active ? clamp01(machine.progress / DISC_TRANSFER_LANDING) : machine.progress);
      worm.layoutReady = true;
      applyTransition();
      return true;
    };

    const startHold = (kind, event, sinceMs) => {
      // One hold at a time, ever. A second press mid-transition would overwrite
      // the timeline of the first and leave the mask half drawn. A recoil is not
      // a hold: it is only the cancel fading out, so a new press may cut it off.
      if (worm.kind && worm.kind !== 'recoil') return;
      // No station layer means nowhere to fly to: stay on the hole and leave the
      // old long press to do whatever it did. Checked before the recoil is
      // dropped, so a refused start leaves nothing half cleared behind it.
      if (kind === 'enter' && !layer) return;
      // A recoil keeps its direction and preparation. Resume the same geometry
      // clock, even after an exit has crossed the halfway point.
      const resuming = worm.kind === 'recoil';
      if (resuming && (kind === 'exit') !== (worm.recoilTarget === 1)) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        return false;
      }
      if (kind === 'enter' && !prepareDiscTransfer()) return false;
      const duration = kind === 'enter'
        ? (reducedMotion ? 1 / WORM_CALM_RATE - 0.03 : WORM_END_S)
        : (reducedMotion ? 1 / TRANSITION_RATE : WORM_END_S);
      // Every inverse here is taken on the blend the timeline itself walks, so a
      // resumed leg lands exactly on the frame the eye left. The exit walks its
      // blend downwards, from the cluster to the hole, so its distance into the
      // leg is the complement of that blend — the same number the arc draws.
      const blendNow = clamp01(machine.progress);
      const walked = kind === 'enter' ? blendNow : 1 - blendNow;
      // The inverse smoothstep is a cubic, so it is exact at both ends: the leg
      // never resumes a rounding error past the frame it was told to hold.
      const phase = inverseSmoothstep(walked);
      const resumeAt = resuming ? phase * duration : 0;
      const p = ringPoint(event);
      worm.kind = kind;
      if (kind === 'enter') worm.target = 'cluster';
      worm.landed = false;
      worm.locked = false;
      worm.armed = resuming && worm.armed;
      worm.settling = false;
      worm.pulsed = false;
      worm.phase = null;
      worm.from = null;
      worm.alpha = 0;
      worm.charge = 0;
      worm.hiddenAt = 0;
      worm.pointerId = event.pointerId;
      worm.button = event.button === 2 ? 2 : 0;
      // Capture once before starting the clock, just as entry does.
      if (kind === 'exit' && !worm.armed) {
        armExit();
        if (!worm.kind) return false;
      }
      // `sinceMs` is the real pointer-down, so the wait before the ring draws
      // costs the gesture nothing: the hold is still WORM_END_S long.
      worm.startedAt = (typeof sinceMs === 'number' ? sinceMs : performance.now()) - resumeAt * 1000;
      worm.downX = event.clientX;
      worm.downY = event.clientY;
      worm.cursorX = p.x;
      worm.cursorY = p.y;
      // The arc reads the very same geometry scalar in either direction, taken
      // as the ring draws it: the entry fills it, the exit empties it.
      if (holdRing) {
        holdRing.show(p.x, p.y);
        const arc = kind === 'enter' ? blendNow : 1 - blendNow;
        holdRing.setProgress(Math.min(0.999, arc), p.x, p.y);
      }
      dirty = true;
      requestFrame();
      return true;
    };

    /**
     * Throw the hold away. The frame is already part way through the fall — the
     * mask has been growing since the press — so the cancel is a short recoil
     * back to where the frame stood, not a cut. That is `WORM_RECOIL_S` of
     * damped retreat instead of a jump the eye would catch.
     */
    const cancelHold = (force) => {
      if (!worm.kind || worm.kind === 'recoil') return;
      // Once the ring is full the crossing has committed: letting go of the
      // pointer no longer cancels it, or the burst would be swallowed by the
      // recoil the instant the hand lifts.
      if (worm.locked && !force) return;
      // Only the wind-up has to be given back. Once the burst has started there
      // is nothing here to undo — the lens does not leave. An exit that has run
      // its preparation but not its lock is still reversible: the cluster is
      // already half gone and has to come back.
      const wasExit = worm.kind === 'exit';
      // Either leg retreats from whatever is on screen. An exit that has armed
      // has the cluster half gone and the hole half back, so releasing it must
      // rewind rather than commit. A press that never moved the clock has
      // nothing on screen yet and ends where it started.
      const drawn = (worm.kind === 'enter' && (machine.wormCharge > 0.004 || machine.progress > 0.0001)) || (wasExit && (Math.abs(machine.progress - worm.progressBefore) > 0.0001 || worm.blend < 0.999));
      // `armed` is the exit's own window into the entry. Lifting off inside it
      // with nothing drawn is the one release that leaves no hold at all.
      if (wasExit && worm.armed && !drawn) worm.armed = false;
      const recoiling = drawn;
      worm.locked = false;
      worm.hiddenAt = 0;
      worm.pointerId = -1;
      worm.button = 0;
      if (recoiling) {
        // Retreated from the swell that is on screen right now, so the release
        // starts where the eye left it rather than unwinding a fixed 1 s. An
        // exit retreats toward the cluster it was leaving, not toward the hole.
        worm.kind = 'recoil';
        worm.charge = machine.wormCharge;
        // Lifting off an armed exit rewinds back toward the cluster it was
        // leaving; the hole keeps its destination so the mode never flips.
        worm.recoilTarget = wasExit ? 1 : 0;
        if (wasExit) {
          machine.returning = false;
          machine.target = 1;
        }
        // Where the frame actually stands: the scalar is the frame that has
        // already been drawn, in both legs. `worm.blend` is the same value on an
        // exit but lags it by a frame on an entry, so the scalar is the one that
        // can be resumed from without moving the picture.
        worm.recoilBlend = clamp01(machine.progress);
        worm.blend = machine.progress;
        worm.startedAt = performance.now();
      } else {
        if (holdRing) holdRing.hide();
        // Letting go before anything moved puts the hole back where it was: an
        // armed exit has already stood the timeline at the top of the walk.
        if (wasExit) machine.target = 1;
        if (wasExit && !worm.armed) {
          worm.kind = null;
          worm.phase = null;
        }
        if (!wasExit) {
          // Even a tap prepared captured fragments before the clock advanced.
          driveCharge(0);
          driveCluster(0);
          if (layer) layer.setBurst(0);
          settleExit();
        }
        // An exit prepared its settlement on the press even when the ring never
        // filled, so whichever placeholder the pointer left behind is finished
        // here — untouched past that point, it would never notice a release.
        if (wasExit && worm.armed) {
          worm.settling = true;
          requestFrame();
        }
        worm.armed = false;
      }
      dirty = true;
      requestFrame();
    };

    /**
     * The exit's one-time preparation: the space hand-over. It reserves a
     * starting point for the cluster (progress one, camera home) so the exit can
     * walk the same numbers the entry drove backwards. Nothing visible happens
     * until the clock moves, so a press that never advances has no first frame to
     * take back.
     */
    const armExit = () => {
      if (worm.armed) return;
      // Which space is being left decides the target: the cluster field has the
      // hole one step up, so the gesture is always "one level", never a jump.
      const fromCluster = machine.progress > 0.5;
      if (reducedMotion && !fromCluster) {
        // Nothing to hand back: the press ends where it began. Published first,
        // because a cancel may only throw away a press that exists.
        worm.kind = 'exit';
        cancelHold(true);
        return;
      }
      worm.armed = true;
      worm.progressBefore = machine.progress;
      worm.target = fromCluster ? 'cluster' : 'field';
      // A settled cluster returns using its live particles. No readback, new
      // population or reverse-flight material swap on the first moving frame.
      // The transfer is checked and cleared below, not used to pick a branch:
      // leaving a stale one active hid the whole cluster layer on the exit
      // (applyTransition drops it once handoff reaches zero) and replaced the
      // gather with a second population of captured disc material.
      machine.returning = !reducedMotion && fromCluster && machine.progress >= 0.999;
      if (fromCluster) {
        // Whatever the entry captured is spent. A settled entry usually has
        // already ended it; end() is idempotent, so this covers the rest and
        // guarantees the exit has exactly one way back.
        discTransfer.end();
        disk.setDiscTransfer(-1);
      }
      // Stand the numbers at the start of the backward walk. The blend does not
      // change, so the first frame is the frame the press landed on.
      if (fromCluster) exitCluster({});
      // The cluster leg is reversible under this timeline, so the lock waits for
      // the ring to be full.
      if (worm.target !== 'cluster') worm.locked = true;
    };

    /** The hold committed: from here the timeline cannot be stopped. */
    const lockHold = () => {
      if (worm.locked) return;
      worm.locked = true;
      // The hold closed, so a release can no longer throw it away. Pin the
      // scalar to the frame the blend actually ended on: a release in the same
      // frame as the landing otherwise hands back a cluster the exit had
      // already left, because the cancel walks the scalar, not the blend.
      machine.progress = worm.kind === 'enter' ? 1 : 0;
    };

    /**
     * The cluster is installed and the camera starts its dolly here: the frame
     * is already moving while the ring keeps filling.
     */
    /**
     * The cluster is installed and the camera starts its dolly here: the frame
     * is already moving while the ring keeps filling.
     */
    const beginCover = () => {
      if (machine.target < 0.5) enterCluster();
    };

    /**
     * The ring is about to pass full: freeze the layer where the eye now has it
     * and stop the headless scalar. On the entry the cluster must not keep
     * climbing while the camera is still on its way there; on the way back the
     * disc has already assembled, and finishing means ending the hold, not
     * unwinding it.
     */
    const handOver = () => {
      if (layer) {
        layer.setCluster(machine.layout);
        layer.setClusterAmount(1);
      }
      machine.progress = machine.target;
    };

    /**
     * Put the cluster back after an exit was released before its ring filled.
     * The exit preparation already handed the space over (exitCluster), so the
     * undo is the mirror of it: the field comes back, the disc stops being the
     * destination, and the camera returns to the cluster's framing.
     */
    const restoreClusterAfterCancel = () => {
      // Nothing to give back: the cluster only comes back if a press was
      // actually undone. A late release in the landing frame lands here
      // after the scalar has already been walked to the hole, and walking
      // it back would put the cluster on screen with nothing holding it.
      if (worm.progressBefore <= 0 && worm.recoilBlend <= 0) return;
      const layout = machine.layout;
      // A cancel usually lands on a settled cluster, where the scalar is already
      // one. It can also arrive while an entry is still climbing (press the hole,
      // release, then long-press the centre again before the entry gets there):
      // pushing the scalar to one there would jump the view into the cluster, so
      // only a settled frame is sent all the way home.
      const settled = worm.progressBefore > 0.999;
      const resume = settled ? 1 : clamp01(worm.progressBefore);
      driveCharge(0);
      driveCluster(resume);
      driveDark(0);
      if (layer) layer.setBurst(0);
      if (settled) {
        discTransfer.end();
        disk.setDiscTransfer(-1);
        disk.setStationSpin(1);
      }
      machine.returning = false;
      machine.target = 1;
      machine.progress = resume;
      machine.wormDark = 0;
      if (layer) {
        if (layout) layer.setCluster(layout);
        // A resumed entry keeps feeding the disc transfer: driveCluster above
        // already set the flow for this blend, and clearing it here would stop
        // the particles that are still in flight.
        if (settled) layer.setFlow(-1);
      }
      if (layout && layout.camera) {
        rig.setHome({
          radius: layout.camera.radius,
          phi: layout.camera.phi,
          theta: layout.camera.theta,
          minRadius: layout.minRadius,
          maxRadius: layout.maxRadius,
        });
      }
      applyTransition();
      worm.layoutReady = false;
      worm.charge = 0;
      worm.blend = 0;
      worm.armed = false;
      worm.progressBefore = 0;
      worm.recoilTarget = 0;
      worm.recoilBlend = 0;
      worm.kind = null;
      worm.target = 'cluster';
      worm.locked = false;
      worm.phase = null;
      worm.from = null;
      worm.alpha = 0;
      worm.hiddenAt = 0;
      worm.pointerId = -1;
      worm.button = 0;
      // The cluster is the space on screen now: without this a cancel can leave
      // the scalar at 1 while mode still says black-hole, and then nothing in
      // the cluster responds until the user leaves and comes back.
      machine.mode = settled ? 'cluster' : 'black-hole';
      transitioning = !settled;
      syncDataset();
      notifyMode();
      dirty = true;
      requestFrame();
    };

    /**
     * Put the disc back exactly as it was after a release took the hole hold
     * back. The layout was only installed to give the under-hand move a
     * destination, so it has to go, or the next press starts from a half-built
     * cluster.
     */
    const settleExit = () => {
      const restoreHole = machine.target === 1;
      if (restoreHole) {
        machine.target = 0;
        machine.categoryId = null;
        machine.layout = null;
        machine.pendingFocus = null;
        transitioning = false;
      }
      if (layer) {
        layer.setCluster(null);
        layer.setFlow(-1);
      }
      discTransfer.end();
      disk.setDiscTransfer(-1);
      disk.setStationSpin(1);
      applyTransition();
      worm.settling = false;
      worm.layoutReady = false;
      worm.charge = 0;
      worm.blend = 0;
      worm.armed = false;
      worm.kind = null;
      worm.phase = null;
      worm.from = null;
      worm.alpha = 0;
      if (restoreHole) {
        const saved = machine.savedCamera;
        const limits = holeOrbitLimits();
        rig.setHome({
          radius: saved && saved.radius ? saved.radius : undefined,
          phi: saved && saved.phi ? saved.phi : undefined,
          theta: saved && Number.isFinite(saved && saved.theta) ? saved.theta : undefined,
          minRadius: limits.minRadius,
          maxRadius: limits.maxRadius,
        });
        notifyMode();
      }
      dirty = true;
    };

    const finishWormhole = () => {
      // Land exactly on the end state rather than a frame short of it. The
      // destination is the cluster field for the hole ↔ cluster leg.
      const target = worm.target === 'field' ? 'field' : 'cluster';
      // The leg is cleared by its own landing frame, so the direction is read
      // from what that frame left behind rather than from `kind`.
      const landed = worm.landedLeg === 'enter';
      if (landed) {
        if (machine.target < 0.5) enterCluster();
      } else {
        machine.progress = 0;
      }
      machine.returning = false;
      // The hand-off is over before the last upload: the disc is the one on
      // screen again, so the transfer must not keep drawing the endpoint the
      // hole pass would fade out.
      discTransfer.end();
      disk.setDiscTransfer(-1);
      applyTransition();
      // The mode follows the scalar, never the other way round: the field is
      // on screen before the host is told it is the space it is in.
      transitioning = false;
      // Both legs share one surface: the hole with its disc, or the cluster
      // those same stations fell into. Where the press started only decides
      // the flight, never which of the two is on screen at the end.
      machine.mode = landed ? 'cluster' : 'black-hole';
      if (!landed && target !== 'field') {
        machine.categoryId = null;
        machine.layout = null;
        machine.pendingFocus = null;
      }
      syncDataset();
      notifyMode();
      // The passage is over: no cones, no swell, no dimmer left on the frame.
      if (layer) layer.setBurst(0);
      // Hand the blend back to the layer, already at the value it should rest on.
      if (layer) layer.setFlow(-1);
      machine.wormCharge = 0;
      machine.wormDark = 0;
      discTransfer.end();
      disk.setDiscTransfer(-1);
      disk.setStationSpin(1);
      if (layer) layer.setTakeover(0);
      if (layer) layer.setCharge(0);
      if (holdRing) {
        // This function runs after the endpoint draw for both directions.
        if (landed) holdRing.complete();
        else holdRing.hide();
      }
      worm.layoutReady = false;
      worm.landed = false;
      worm.blend = 0;
      worm.kind = null;
      worm.locked = false;
      worm.armed = false;
      worm.recoilTarget = 0;
      worm.recoilBlend = 0;
      worm.progressBefore = 0;
      worm.landedLeg = null;
      worm.from = null;
      worm.alpha = 0;
      worm.charge = 0;
      worm.hiddenAt = 0;
      worm.pointerId = -1;
      worm.button = 0;
      applyTransition();
      dirty = true;
      requestFrame();
    };

    /** A second right press mid-exit: land now instead of waiting. */
    const skipWormhole = () => {
      // Only a running exit can be landed early. Skipping an entry would drop
      // its commit, and skipping before the lock would jump the ring itself.
      if (!worm.kind || worm.kind !== 'exit' || !worm.armed) return false;
      worm.startedAt -= 10 * 1000;
      requestFrame();
      return true;
    };

    /**
     * The hold's three channels. `progress` is the geometry — the disc tearing
     * open along its axis and folding back down into the cluster; `charge` is
     * only the wind-up that comes before the commit; `dark` is the dimmer the
     * fold is watched through. Each is written from the wall clock, so a dropped
     * frame shortens the animation instead of desynchronising the parts.
     */
    const driveCluster = (value) => {
      const next = clamp01(value);
      // The cones are built out of this same blend, so the layer has to be
      // told to run on this clock rather than on its own ease. Done before the
      // no-op check: on the first frame of the burst the value has not moved
      // yet, but the handover still has to happen.
      if (layer) layer.setFlow(discTransfer.active ? clamp01(next / DISC_TRANSFER_LANDING) : next);
      if (next === machine.progress || (next > 0 && next < 1 && Math.abs(next - machine.progress) < 1e-4)) return;
      machine.progress = next;
      dirty = true;
    };

    const driveCharge = (value) => {
      const next = clamp01(value);
      if (Math.abs(next - machine.wormCharge) < 1e-4) return;
      machine.wormCharge = next;
      if (layer) layer.setCharge(next);
      applyTransition();
      dirty = true;
    };

    const driveDark = (value) => {
      const next = clamp01(value);
      if (Math.abs(next - machine.wormDark) < 1e-4) return;
      machine.wormDark = next;
      applyTransition();
      dirty = true;
    };

    /**
     * The one envelope both cones ride, evaluated on the same blend the layer
     * uses, so the sprite swell cannot drift from the flight it is describing.
     * Zero on the disc, one at the top of the cone, zero again on the cluster.
     */
    /**
     * The one envelope both cones ride, evaluated on the same blend the layer
     * uses, so the sprite swell cannot drift from the flight it is describing.
     * Zero on the disc, one at the top of the cone, zero again on the cluster.
     * The layer eases the blend before taking the sine, so this does too.
     */
    const burstOf = (blend) => Math.sin(Math.PI * smoothstep01(clamp01(blend)));

    /**
     * How much light the passage is allowed, as a function of the same blend.
     * One hump, deepest while the cones fold back down, and it is gone by the
     * time the three threads land — the dark is where the fold hides, not a
     * fade laid over the whole trip. Keyed on `blend` so running the timeline
     * backwards reproduces it exactly.
     */
    // No dark hold in this passage. The matter is thrown and lands in one
    // continuous move; dimming the frame halfway through was what made it read
    // as two separate events.
    const darkAt = () => 0;

    const advanceWormhole = (now) => {
      // A release before the clock moved: the exit prepared nothing visible, so
      // there is no picture to give back — the settlement is just finished.
      if (!worm.kind) {
        if (!worm.settling) return false;
        settleExit();
        return true;
      }
      // A hidden page keeps no time. Freezing the timeline here is what makes the
      // give-back in onFocus honest: without it the compensation would rewind the
      // transition by the time the frames kept running.
      if (worm.hiddenAt) return true;
      const t = (now - worm.startedAt) / 1000;

      // A cancelled hold un-winds. The travel has already begun under the hand,
      // so it has to come back too: the points slide home on the same short
      // clock, and nothing is left in flight when the press ends.
      if (worm.kind === 'recoil') {
        const start = worm.charge;
        const targetBlend = worm.recoilTarget || 0;
        const startBlend = targetBlend === 1 ? clamp01(worm.recoilBlend) : (worm.blend || 0);
        // A retreat from further out has further to travel: giving the cluster
        // back takes longer the closer the exit had already got to the hole,
        // and taking a formed cluster apart again deserves the same grace.
        const span = targetBlend === 1
          ? WORM_RECOIL_S * (1 + 2 * (1 - startBlend))
          : WORM_RECOIL_S * (1 + 2 * startBlend);
        const e = smoothstep01(clamp01(1 - t / span));
        const blend = targetBlend + (startBlend - targetBlend) * e;
        driveCharge(start * e);
        driveCluster(blend);
        if (holdRing) holdRing.setProgress(Math.min(0.999, targetBlend === 1 ? 1 - blend : blend), worm.cursorX, worm.cursorY);
        if (layer) layer.setBurst(reducedMotion || machine.returning ? 0 : burstOf(blend));
        dirty = true;
        if (t >= span) {
          if (holdRing) holdRing.hide();
          if (targetBlend === 1) {
            restoreClusterAfterCancel();
            return true;
          }
          driveCharge(0);
          driveCluster(0);
          if (layer) layer.setBurst(0);
          settleExit();
        }
        return true;
      }

      if (worm.kind === 'enter') {
        // Prepare the real 13-category destination before the first moving frame,
        // including when a slow first frame has already crossed the lock point.
        if (layer && !worm.layoutReady) prepareDiscTransfer();
        // One clock for both directions: the hold has to be held for the whole
        // travel, and the ring reads the same number the layer does.
        const arrival = reducedMotion ? 1 / WORM_CALM_RATE - 0.03 : WORM_END_S;
        const travel = smoothstep01(clamp01(t / arrival));
        // The cluster is installed at the old 1 s mark, so the frame is already
        // moving while the ring keeps filling.
        if (t >= (reducedMotion ? 0 : WORM_RING_S) && !worm.armed) {
          worm.armed = true;
          beginCover();
        }
        if (t >= HOLD_PULSE_S && !worm.pulsed && holdRing) {
          worm.pulsed = true;
          holdRing.pulse();
        }
        // The ring is full: the crossing has happened. The cluster is on screen
        // already, so the blend snaps to one and the hold ends here rather than
        // spending another frame walking a scalar nothing is drawn from.
        if (t >= arrival) {
          worm.pulsed = true;
          worm.blend = 1;
          driveCharge(0);
          driveCluster(1);
          if (layer) layer.setBurst(0);
          driveDark(0);
          handOver();
          // The cluster is installed, so the crossing is done here: fill the
          // ring only after this frame has been drawn, and report the mode with
          // it. The leg is cleared for the same frame — `landed` would re-enter
          // this branch forever — so the tick picks the fill up from `pulseEnd`.
          worm.pulseEnd = true;
          // The hand-over reads the direction off this: by the time the tick
          // finishes the hold the leg is already cleared, and a crossing that
          // forgot it landed on the hole it came from.
          worm.landedLeg = 'enter';
          worm.kind = null;
          worm.locked = false;
          worm.armed = false;
          return true;
        }
        worm.blend = travel;
        driveCharge(reducedMotion ? 0 : Math.sin(Math.PI * travel));
        driveCluster(travel);
        if (layer) layer.setBurst(reducedMotion ? 0 : burstOf(travel));
        driveDark(0);
        if (holdRing) {
          // Keep the arc below full until the endpoint has actually been drawn.
          holdRing.setProgress(Math.min(0.999, travel), worm.cursorX, worm.cursorY);
        }
        dirty = true;
        return true;
      }

      // Leaving for the hole: the entry run backwards, on the same clock. The
      // cluster comes apart first and the disc reassembles last because that is
      // what the forward passage looks like from the other end. The blend reads
      // from where the frame actually stands, which is the only safe thing
      // after an interrupted press.
      const end = reducedMotion ? 1 / TRANSITION_RATE : WORM_END_S;
      const u = clamp01(t / end);
      const blend = t >= end ? 0 : 1 - smoothstep01(u);
      driveCluster(blend);
      // The exit has to leave the same trail the entry does, or a release would
      // retreat to the hole it started from instead of to the frame on screen.
      worm.blend = blend;
      // Told after the arrangement, because settling the framing rewrites the
      // layer's flow and only the no-op branch leaves a resumed flow alone.
      if (discTransfer.active) layer.setFlow(clamp01(machine.progress / DISC_TRANSFER_LANDING));
      if (worm.target !== 'field') {
        if (layer) layer.setBurst(reducedMotion || machine.returning ? 0 : burstOf(blend));
        // Coming back to the hole there is nothing to wind up: the disc
        // reassembles at the very end, already at rest.
        driveCharge(0);
        driveDark(darkAt(blend));
      }
      if (holdRing) holdRing.setProgress(Math.min(0.999, 1 - blend), worm.cursorX, worm.cursorY);
      if (t >= HOLD_PULSE_S && !worm.pulsed && holdRing) {
        worm.pulsed = true;
        holdRing.pulse();
      }
      // The disc is assembled at rest the moment it lands: no lock and no
      // camera wait, otherwise the ring would sit full and the field would wait
      // on a dolly that is not running.
      if (t >= end) {
        handOver();
        worm.landedLeg = 'exit';
        worm.kind = null;
        worm.locked = false;
        worm.armed = false;
        worm.landed = true;
      }
      dirty = true;
      return true;
    };

    // ---- pointer / long-press ---------------------------------------------

    const press = { active: false, id: -1, x: 0, y: 0, downX: 0, downY: 0, at: 0, consumed: false, moved: false };
    /** What kind of pointer was used last, so the menu can tell touch from mouse. */
    let lastPointerType = 'mouse';
    let lastHover = 0;
    let longTimer = 0;
    // The touch long-press slot. Separate from `longTimer`, which belongs to the
    // hole's centre: one gesture can only be doing one of those things.
    let cardTimer = 0;
    let cardIndex = -1;
    let cardShown = false;
    // The right press, held in reserve for RIGHT_HOLD_DELAY_S. `null` unless a
    // right press is down and its hold has not begun yet.
    let exitArm = null;

    /** Throw the reserve away. Returns the press that was waiting, or null. */
    const dropExitArm = () => {
      if (!exitArm) return null;
      if (exitArm.timer) clearTimeout(exitArm.timer);
      const pending = exitArm;
      exitArm = null;
      return pending;
    };

    /**
     * Start the right press's countdown. Nothing visible happens until it
     * expires: a release inside the window is a click, and the ring never draws.
     */
    const armRightHold = (event, holdable = true) => {
      dropExitArm();
      const since = performance.now();
      const held = {
        pointerId: event.pointerId,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      const timer = setTimeout(() => {
        const pending = exitArm;
        exitArm = null;
        // Without something to gather, the press is only ever the click: the
        // window closes and the release is what asks for the library.
        if (!pending || !pending.holdable) return;
        startHold('exit', pending.press, pending.since);
      }, RIGHT_HOLD_DELAY_S * 1000);
      exitArm = { timer, press: held, since, holdable };
    };

    const centerAt = (clientX, clientY) => {
      const region = centerRegion();
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      return { inside: Math.hypot(px - region.x, py - region.y) <= region.r, region };
    };

    const canOpenCenter = () => machine.mode === 'black-hole' && machine.progress < 0.05;

    /**
     * One level out, in the same order the hold uses: the cluster field steps
     * back to the hole. Nothing skips a level, so the way out is always the way
     * in reversed. This is the touch twin of the right-button hold.
     */
    const goBackOneLevel = () => {
      if (worm.kind && worm.kind !== 'recoil') return false;
      if (machine.mode === 'cluster') return exitCluster({});
      return false;
    };

    /**
     * A click on the hole's centre opens the search. Holding it is the way
     * into the cluster; releasing early goes back to the hole, not to search.
     */
    const centerClick = () => {
      if (!canOpenCenter()) return;
      clearTimers();
      // The tap opens the search box, and the pointer that tapped is still over
      // the hole: its hover freeze would hold the disc clock for as long as the
      // reader types. Typing is not pinning a station, so the pause ends here.
      holdSpin(false);
      if (typeof settings.onHoleTap === 'function') {
        try {
          settings.onHoleTap();
        } catch {
          /* ignore */
        }
      }
    };

    /**
     * Right click goes back one level: an open cluster returns to the hole, and
     * at the hole itself it does nothing.
     * Suppressing the context menu is what makes the right click a gesture
     * rather than a browser menu.
     */
    const onContextMenu = (event) => {
      event.preventDefault();
      if (document.body && document.body.getAttribute('data-bhrl-no-context') === 'true') return;
      // With the wormhole on, the right button is a hold everywhere: the field
      // walks back by holding, not by clicking, so the menu is merely suppressed
      // here and the pointer handlers own the gesture.
      if (wormholeEnabled && lastPointerType !== 'touch') return;
      // Without the wormhole the cluster still leaves on a plain right click.
      if (machine.mode === 'cluster' || machine.progress > 0.05) {
        if (machine.target > 0.5) exitCluster({});
      }
    };

    const onPointerDown = (event) => {
      lastPointerType = event.pointerType || 'mouse';
      // A fresh press ends the previous card's sticky life; the release decides
      // whether that card goes away.
      hoverSticky = false;
      if (event.button === 2) {
        // Right is the way back out, and only by holding it all the way. A
        // short right press does nothing at all, not even a ring: the press
        // waits RIGHT_HOLD_DELAY_S before its hold may draw anything.
        if (!wormholeEnabled) return;
        // While a hold owns the gesture, nothing else may start one. The only
        // thing a second right press does is land a running exit. A recoil is
        // not a hold — it is the last cancel fading out — so it does not block
        // the next press.
        if (worm.kind && worm.kind !== 'recoil') {
          if (skipWormhole()) event.preventDefault();
          return;
        }
        if (machine.mode === 'black-hole' && machine.progress < 0.05) {
          // Nothing to gather yet: in the hole there is no cluster to pull in,
          // so the press can only become the library's click.
          if (worm.kind === 'recoil' && worm.recoilTarget === 0) event.preventDefault();
          event.preventDefault();
          armRightHold(event, false);
          return;
        }
        event.preventDefault();
        // Right is one press with two readings: held past the delay it walks
        // back out, released sooner it is a click and nothing happens. The ring
        // is drawn by the hold, so it cannot appear before that is decided.
        armRightHold(event);
        return;
      }
      if (event.button !== 0) return;
      dropExitArm();
      // A hold owns the gesture: a left press during one is not a selection, and
      // it must not be able to cancel the hold that is already running. A recoil
      // is the one exception: pressing again is how you take the fall back up.
      if (worm.kind && worm.kind !== 'recoil') return;
      // One press slot. A second finger does not take it over, or the first
      // finger's release would no longer cancel the hold it started.
      if (press.active && press.id !== event.pointerId) return;
      press.active = true;
      press.id = event.pointerId;
      press.x = event.clientX;
      press.y = event.clientY;
      press.downX = event.clientX;
      press.downY = event.clientY;
      press.at = performance.now();
      press.consumed = false;
      press.moved = false;
      // The centre is entered by holding it. A press and release there is a
      // click on the hole, which opens the search.
      if ((canOpenCenter() || (worm.kind === 'recoil' && worm.recoilTarget === 0)) && (!worm.kind || worm.kind === 'recoil') && centerAt(event.clientX, event.clientY).inside) {
        if (wormholeEnabled) {
          // The hold draws its own ring, so the press is consumed now: the
          // release must not also select something.
          press.consumed = true;
          startHold('enter', event);
          return;
        }
      }
      // Touch has no hover and no right button: holding empty space is the way
      // back one level, the same gesture the centre uses to go in. A drag
      // clears it, so orbiting never fires it by accident. A touch press on a
      // station is a play, never a card: the scene names the hovered station
      // itself and has nothing to hold open.
      if (lastPointerType === 'touch' && machine.mode === 'cluster') {
        longTimer = setTimeout(() => {
          longTimer = 0;
          if (!press.active || press.moved) return;
          press.consumed = true;
          goBackOneLevel();
        }, TOUCH_BACK_MS);
      }
    };

    const onPointerMove = (event) => {
      // Hover can start long after the last press, so the pointer type here is
      // the live one: a mouse moving over a touch-opened card must be treated as
      // a mouse, not as the finger that opened it.
      lastPointerType = event.pointerType || 'mouse';
      // A hold is a hold only while the pointer stays put. Six pixels of slop
      // covers the hand shaking on a trackpad; past that it is a drag and the
      // camera is what the gesture belongs to.
      if (exitArm && event.pointerId === exitArm.press.pointerId
        && Math.hypot(event.clientX - exitArm.press.clientX, event.clientY - exitArm.press.clientY) > WORM_DEADZONE_PX) {
        dropExitArm();
      }
      if (worm.kind && event.pointerId === worm.pointerId) {
        if (!worm.locked && Math.hypot(event.clientX - worm.downX, event.clientY - worm.downY) > WORM_DEADZONE_PX) {
          cancelHold();
        }
        return;
      }
      if (press.active && press.id === event.pointerId) {
        if (Math.hypot(event.clientX - press.downX, event.clientY - press.downY) > CLICK_SLOP) {
          press.moved = true;
          if (longTimer) {
            clearTimeout(longTimer);
            longTimer = 0;
          }
          // A drag is a camera gesture: it must not leave a card timer armed or
          // the card would appear under a thumb that has already moved on.
          if (cardTimer) {
            clearTimeout(cardTimer);
            cardTimer = 0;
            cardIndex = -1;
          }
        }
        return;
      }
      // The record's freeze follows the pointer itself, ahead of the hover
      // throttle and ahead of any pick: it has to catch the entry into the disc
      // while the pointer is still between two stations, and it must not lag 90
      // ms on the way out either.
      trackDiscRegion(event.clientX, event.clientY);
      const now = performance.now();
      if (now - lastHover < HOVER_INTERVAL_MS) return;
      lastHover = now;

      if (machine.mode === 'cluster' && machine.progress > 0.5) {
        const index = pick(event.clientX, event.clientY);
        if (index >= 0) {
          canvas.style.cursor = 'pointer';
          emitHover(index, event.clientX, event.clientY);
          return;
        }
        clearHover();
        return;
      }

      if (!canOpenCenter()) {
        canvas.style.cursor = 'grab';
        return;
      }

      const hit = centerAt(event.clientX, event.clientY);
      // A pointer over a fixture image gets a pointer cursor from the same id
      // read a press would use.
      const overRadio = radio ? pickRadio(event.clientX, event.clientY) : null;
      if (overRadio || hit.inside) {
        // The fixture image and the hole centre are controls of their own; they
        // are not stations, so nothing on the disk stays hovered through them.
        canvas.style.cursor = 'pointer';
        clearHover();
        return;
      }
      const index = pick(event.clientX, event.clientY);
      canvas.style.cursor = index >= 0 ? 'pointer' : 'grab';
      // Hover belongs to the disk alone. The cluster is a browsing space whose
      // click selects, so a card there would promise playback the click does not
      // deliver.
      if (machine.progress > 0.5) {
        clearHover();
        return;
      }
      if (index >= 0) emitHover(index, event.clientX, event.clientY);
      else clearHover();
    };

    const onPointerUp = (event) => {
      // A drag that started on the disc and ended off it leaves no move behind
      // to re-read the region, so the release settles it: the record must not
      // stay frozen under a pointer that has already been put down.
      trackDiscRegion(event.clientX, event.clientY);
      if (event.button === 2) {
        // A release before the hold began is the click half of the gesture: no
        // ring was drawn, so the press asks for the library instead.
        const clicked = dropExitArm();
        if (clicked) {
          if (
            clicked.press.pointerId === event.pointerId &&
            typeof settings.onFavourites === 'function'
          ) {
            settings.onFavourites(clicked.press.clientX, clicked.press.clientY);
          }
          return;
        }
        // Letting go of the right button before the ring fills is a cancel.
        // Only the very button that opened the hold may end it. A short right
        // press has no hold to end and does nothing else.
        if (worm.kind && !worm.locked && event.pointerId === worm.pointerId && event.button === worm.button) {
          cancelHold();
        }
        return;
      }
      if (!press.active || press.id !== event.pointerId) return;
      press.active = false;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      if (cardTimer) {
        clearTimeout(cardTimer);
        cardTimer = 0;
      }
      // Releasing before the ring fills is the cancel. This must come before the
      // consumed check: the press was consumed at pointer down precisely so the
      // release would not select anything, and the hold still has to end.
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId && event.button === worm.button) {
        cancelHold();
      }
      if (press.consumed) {
        press.consumed = false;
        cardIndex = -1;
        cardShown = false;
        // The centre press was consumed at pointer down so its release would not
        // also select a station. A quick release that never became a hold is
        // still a tap on the hole, and the hole is the search box's handle.
        const tapMoved = Math.hypot(event.clientX - press.downX, event.clientY - press.downY);
        const tapHeld = performance.now() - press.at;
        // A release that cancelled its own wind-up leaves a recoil behind, and a
        // recoil is not a crossing: the tap still belongs to the hole.
        const wormIdle = !worm.kind || worm.kind === 'recoil';
        if (wormIdle && isSelectionGesture(tapMoved, tapHeld) && centerAt(press.downX, press.downY).inside && typeof settings.onHoleTap === 'function') {
          settings.onHoleTap();
        }
        return;
      }
      const moved = Math.hypot(event.clientX - press.downX, event.clientY - press.downY);
      const held = performance.now() - press.at;
      if (!isSelectionGesture(moved, held)) return;
      // One level in from the cluster: a tap on a star plays that station. A tap
      // that misses every star does nothing at all: no clear, no exit.
      if (machine.mode === 'cluster') {
        const index = pick(event.clientX, event.clientY);
        if (index >= 0) playStation(index);
        return;
      }
      // The id channel wins over the centre control: if a fixture is drawn at
      // this pixel, the click belongs to the fixture, whatever is under it.
      const radioHit = pickRadio(event.clientX, event.clientY);
      if (radioHit) {
        selectRadio(radioHit.businessId, radioHit.branch);
        return;
      }
      if (centerAt(event.clientX, event.clientY).inside) {
        // A press that ended before the ring filled is a tap on the hole, and
        // the hole is the search box's handle now: a tap opens it. Holding is
        // still what enters the genre field, so the two gestures never collide
        // — a completed hold consumed this press at pointer down.
        if (typeof settings.onHoleTap === 'function') settings.onHoleTap();
        return;
      }
      // A touch press already resolved its target at pointer down; re-picking on
      // release would let a millimetre of thumb drift change the station.
      const index = cardIndex >= 0 ? cardIndex : pick(event.clientX, event.clientY);
      cardIndex = -1;
      cardShown = false;
      if (index >= 0) {
        if (machine.progress > 0.5) {
          // The cluster is a browse space: a click there still means "show me
          // this one", and it still brings the camera to it.
          clearRadioSelection();
          select(index, { focus: true, notify: true });
        } else {
          playStation(index);
        }
      } else {
        clearSelection(true);
        clearRadioSelection();
        clearHover();
      }
    };

    const onPointerCancel = (event) => {
      dropExitArm();
      press.active = false;
      press.consumed = false;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      // A cancelled touch never resolved its target: without this the next
      // unrelated click would play the station the cancelled press sat on.
      if (cardTimer) {
        clearTimeout(cardTimer);
        cardTimer = 0;
      }
      cardIndex = -1;
      cardShown = false;
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId) cancelHold();
    };

    const onPointerLeave = (event) => {
      dropExitArm();
      canvas.style.cursor = 'grab';
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId) cancelHold();
      // Leaving the canvas is the end of a hover: the card must not outlive the
      // pointer that asked for it. A card a touch press opened is the exception:
      // the finger has to leave the canvas before it can reach a button on it,
      // so that card is dismissed by the next tap instead.
      if (!hoverSticky) clearHover();
      // The disc's footprint is a canvas region: with the pointer off the canvas
      // there is nothing left in it, so the record may turn again. The card the
      // hover just opened can still ask for the freeze back through the panel.
      holdSpin(false);
    };

    const onKeyDown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (!canOpenCenter()) return;
        event.preventDefault();
        centerClick();
      }
    };

    /**
     * Focus loss is the one cancel that never arrives as a pointer event: an
     * alt-tab leaves the button logically down. Drop an uncommitted hold, and
     * for a committed one remember the moment so the timeline resumes from
     * there instead of jumping to the end on the way back.
     */
    const onBlur = () => {
      if (!worm.kind) return;
      if (!worm.locked) {
        cancelHold();
        return;
      }
      worm.hiddenAt = performance.now();
    };
    const onFocus = () => {
      if (!worm.hiddenAt) return;
      worm.startedAt += performance.now() - worm.hiddenAt;
      worm.hiddenAt = 0;
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('blur', onBlur);
      window.addEventListener('focus', onFocus);
      disposers.push(() => {
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
      });
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('contextmenu', onContextMenu);
    disposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
      clearTimers();
    });

    applySize();
    disk.update(0, camera);
    starfield.update(0, 0);
    rig.update(1);
    currentLod = computeLod();
    if (layer) {
      layer.setLod(currentLod);
      const hole = silhouette();
      layer.setHole(hole.x, hole.y, hole.r * 1.02);
    }
    applyTransition();
    syncDataset();
    draw();
    if (!reducedMotion) requestFrame();

    let observer = null;
    const onResize = () => {
      if (applySize() && (!frame || reducedMotion)) requestFrame();
    };
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(onResize);
      observer.observe(container);
    } else {
      window.addEventListener('resize', onResize);
    }
    disposers.push(() => {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', onResize);
    });

    const onVisibility = () => {
      visible = document.visibilityState !== 'hidden';
      if (!visible) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        last = 0;
        clearTimers();
        // A hold cannot stay held while the tab is gone.
        if (worm.kind && !worm.locked) cancelHold();
        else if (worm.kind) worm.hiddenAt = performance.now();
      } else {
        if (worm.hiddenAt) {
          worm.startedAt += performance.now() - worm.hiddenAt;
          worm.hiddenAt = 0;
        }
        last = 0;
        requestFrame();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
      disposers.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }

    const onContextLost = (event) => {
      event.preventDefault();
      contextLost = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      last = 0;
      // In-flight timer queries belong to the lost context; they can never be read
      // back and deleting them after the loss would be a no-op at best.
      try {
        discardGpuQueries();
      } catch {
        /* the context is already gone */
      }
    };
    const onContextRestored = () => {
      contextLost = false;
      last = 0;
      dirty = true;
      requestFrame();
    };
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);
    disposers.push(() => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
    });

    const countTriangles = () => {
      let total = 0;
      scene.traverse((object) => {
        const geometry = object.geometry;
        if (!geometry || !geometry.attributes || !geometry.attributes.position) return;
        const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
        total += count / 3;
      });
      return Math.round(total);
    };

    const info = {
      phase: STAGE_PHASE,
      antialias,
      pixelRatio: ratio,
      triangles: countTriangles(),
      stars: starfield.count,
      stations: stations.length,
      particles: layer ? layer.particleCount : 0,
      featured: featuredCount,
      categories: categories.length,
      animated: !reducedMotion,
    };

    const handle = {
      info,

      /**
       * The host owns whether the search box is up; the scene only has to stop
       * treating the pointer over the disc as a reason to freeze it.
       */
      setSearchOpen(on) {
        searchHeld = Boolean(on);
        if (searchHeld) holdSpin(false);
      },

      /** Ease the camera back to the active mode's authored framing. */
      resetView() {
        rig.reset();
        requestFrame();
      },

      /** Select by catalogue id, crossing scenes when the station is elsewhere. */
      selectById(id, selectOptions) {
        const opts = selectOptions || {};
        if (opts.focus === false) {
          const index = idToIndex.get(String(id));
          if (index === undefined) return false;
          return select(index, opts);
        }
        return focusOrSelect(id);
      },

      focusById(id) {
        return focusOrSelect(id);
      },

      clearSelection,

      /**
       * Close the station card without leaving the scene.
       *
       * The card belongs to a hover, and Escape is the keyboard's way of
       * letting go of it. The pointer is still parked over the spot, so the
       * next move is what may bring a card back — not this frame.
       */
      dismissHover() {
        hoverSticky = false;
        clearHover();
        dirty = true;
        requestFrame();
      },
      locateStation: focusOrSelect,

      /**
       * Panel → stage: the pointer is on the station card.
       *
       * The card sits over the disc, so the pointer has to leave the canvas to
       * reach it — and leaving the canvas would otherwise resume the record
       * underneath someone who is about to click the card's star. The panel is
       * the only one that knows, so it says.
       */
      setCardHover(on) {
        const next = Boolean(on);
        if (cardHeld === next) return;
        cardHeld = next;
        syncSpin();
      },

      /**
       * Where the berths are, in CSS pixels.
       *
       * A berth is a target the eye finds by looking, which makes it awkward to
       * press from a script or a test. This reports what the frame already
       * computed — the projected centre of every classification group — so the
       * field can be driven without guessing screen coordinates.
       */
      clusterPoints() {
        if (!machine.layout || !Array.isArray(machine.layout.groups)) return [];
        return machine.layout.groups.map((group) => {
          const spot = projectCloud(group.center);
          return {
            id: group.id,
            count: group.count,
            radius: group.radius,
            x: Math.round(spot.x),
            y: Math.round(spot.y),
            distance: Math.round(spot.distance * 100) / 100,
          };
        });
      },

      /**
       * Panel → stage: which station is live, and whether it is paused.
       *
       * The disk draws one ring and that ring belongs to playback, so the panel
       * has to say when transport changed for a reason the stage cannot see — a
       * click in the side panel, the media element ending, a host command.
       */
      setPlaying(stationId, paused) {
        const found = stationId == null ? undefined : idToIndex.get(String(stationId));
        const index = found === undefined ? -1 : found;
        if (layer) layer.setPlayingIndex(index, paused === true);
        // The disc reads the same index, so the playing knot breathes in place.
        disk.setStationPlaying(index);
        dirty = true;
        requestFrame();
      },

      /** Panel → stage: the favourite set changed. Recolour only; no relayout. */
      setFavourites(isFavourite) {
        if (layer) layer.setFavourites(isFavourite);
        // The disc's raster carries the favourite bit, so the field has to be
        // rebaked. This runs on a click, never on a frame.
        isFavouriteStation = typeof isFavourite === 'function' ? isFavourite : null;
        rebuildStationField();
        dirty = true;
        requestFrame();
      },

      /**
       * Panel → stage notification of the overlay state. The stage owns the
       * machine, so a panel that opens or closes search must say so; otherwise
       * a held centre would disagree with what is on screen.
       */
      setInteraction(ui) {
        if (ui === 'search') clearTimers();
        setUi(ui);
      },

      enterCluster,
      exitCluster,

      setCategoryFilter(ids) {
        if (!layer) return;
        // Filters belong to the disk state; selecting a cluster replaces them.
        if (machine.progress > 0.2) return;
        layer.setFilter(Array.isArray(ids) ? ids : []);
        dirty = true;
        requestFrame();
      },

      setLanguage(next) {
        const lang = next === 'en' ? 'en' : 'zh';
        labelLanguage = lang;
        dirty = true;
        requestFrame();
      },

      get selection() {
        return selectedStation();
      },

      get state() {
        return stateSnapshot();
      },

      holeScreen() {
        const region = centerRegion();
        return { x: region.x, y: region.y, r: region.r, w: viewport.w, h: viewport.h };
      },

      /**
       * Fixture suite (phase 2). Nothing in the panel uses this; it exists so a
       * GPU harness drives the same code the page draws with, instead of a
       * parallel implementation that could agree with itself and be wrong.
       */
      radio: {
        get enabled() {
          return radio !== null;
        },
        fixtures: radioFixtures.map((fixture) => ({
          businessId: fixture.businessId,
          gpuId: fixture.gpuId,
          kind: fixture.kind,
          label: { ...fixture.label },
          r: fixture.r,
          phi: fixture.phi,
          patchRadius: fixture.patchRadius,
          motion: fixture.motion,
          color: fixture.color.slice(),
        })),
        anchors: () => radioState.anchors.map((anchor) => ({ ...anchor })),
        pick: (clientX, clientY) => pickRadio(clientX, clientY),
        select: (businessId, branch) => selectRadio(businessId, branch),
        clear: () => clearRadioSelection(),
        scan: () => {
          radioState.stale = true;
          dirty = true;
          requestFrame();
        },
        get selected() {
          return radioState.selectedId
            ? { businessId: radioState.selectedId, branch: radioState.selectedBranch }
            : null;
        },
        get frameVersion() {
          return radioState.frameVersion;
        },
        /** Raw probe access, for the GPU harness: same call the page uses. */
        probe: (probeOptions) => disk.probe(probeOptions),
        /** The table textures, so a test can ask gl.isTexture after dispose. */
        tables: () => disk.tables,
        /** The WebGL context, for isTexture() checks after teardown. */
        context: () => renderer.getContext(),
        clearAll: () => {
          clearRadioSelection();
          radioState.anchors = [];
          radioState.stale = true;
          dirty = true;
        },
      },

      dispose() {
        if (disposed) return;
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        clearTimers();
        // A hold is a promise about a transition; teardown must not leave one
        // half-promised with a ring still drawn on the page.
        worm.kind = null;
        worm.locked = false;
        if (holdRing) holdRing.hide();
        // Queries created but never collected would otherwise outlive the context
        // they belong to; delete them while the context is still usable.
        try {
          discardGpuQueries();
        } catch {
          /* the context may already be gone */
        }
        if (typeof window !== 'undefined' && window.__BHRL_DEBUG__ === debug) {
          try {
            delete window.__BHRL_DEBUG__;
          } catch {
            /* a frozen page still tears down everything else */
          }
        }
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* one bad listener must not strand the rest of the teardown */
          }
        }
        disposers.length = 0;
        for (const part of parts) {
          try {
            part.dispose();
          } catch {
            /* geometry may already be gone with the context */
          }
        }
        parts.length = 0;
        scene.clear();
        renderer.dispose();
        const lose = renderer.forceContextLoss;
        if (typeof lose === 'function') {
          try {
            lose.call(renderer);
          } catch {
            /* already lost with the context */
          }
        }
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };

    // Read-only verification surface, version 6: phase 2 added the fixture
    // probes (ids 26-32) and the pixel-exact pick that goes with them.
    const debug = {
      version: 6,
      /**
       * TEMPORARY DIAGNOSTIC (thin-arc investigation). Hands out the live scene
       * graph and camera so a probe page can place the eye at an exact framing
       * and toggle one part at a time. Debug-only surface; no plugin code path
       * reads it, and it is removed when the investigation closes.
       */
      handles() {
        return { scene, camera, rig, renderer, canvas, parts: { starfield, disk, layer, discTransfer } };
      },
      /** TEMPORARY DIAGNOSTIC: synchronously draw and read the frame back. */
      renderNow() {
        renderer.render(scene, camera);
        return canvas.toDataURL('image/png');
      },
      get stationCount() {
        return stations.length;
      },
      get featuredCount() {
        return featuredCount;
      },
      get lod() {
        return currentLod;
      },
      get selectedId() {
        return selectedId;
      },
      get selectedIndex() {
        return selectedIndex;
      },
      get filter() {
        return layer ? layer.filterInfo() : { active: false, strength: 0, matched: 0, clouds: [] };
      },
      get animating() {
        return (layer ? layer.isAnimating : false) || transitioning;
      },
      /** The hold as the frame loop sees it, for verification only. */
      wormhole() {
        return {
          enabled: wormholeEnabled,
          kind: worm.kind,
          locked: worm.locked,
          target: worm.target,
          before: worm.progressBefore,
          landed: worm.landed,
          settling: worm.settling,
          elapsed: worm.kind ? (performance.now() - worm.startedAt) / 1000 : 0,
          cover: 0,
          // What is actually on screen, so a capture can be checked without
          // reading pixels: radius in viewport heights, and the mask's own alpha.
          mask: worm.phase
            ? {
                radius: Math.round(worm.phase.radius * 1000) / 1000,
                alpha: Math.round(worm.phase.alpha * 1000) / 1000,
                streak: Math.round(worm.phase.streak * 1000) / 1000,
                rim: Math.round(worm.phase.rim * 1000) / 1000,
              }
            : null,
        };
      },
      /** Begin a hold without a pointer, at the hole's centre. */
      beginHold(kind) {
        // `kind` reads 'recoil' while a cancel is retreating; that is not a hold
        // and may be cut off, exactly like a real press may.
        if (!wormholeEnabled || (worm.kind && worm.kind !== 'recoil')) return false;
        if (kind === 'enter' && !canOpenCenter()) return false;
        if (
          kind === 'exit'
          && !(machine.mode === 'cluster' || machine.progress > 0.05)
        ) return false;
        const rect = container.getBoundingClientRect();
        const hole = silhouette();
        return startHold(kind, { clientX: rect.left + hole.x, clientY: rect.top + hole.y }) === true;
      },
      endHold() {
        if (worm.kind && !worm.locked) cancelHold();
        return true;
      },
      /** Move the hold's clock, so a single frame can be inspected without
       *  waiting for the whole timeline in real time. */
      seekHold(seconds) {
        if (!worm.kind) return 0;
        worm.startedAt = performance.now() - seconds * 1000;
        requestFrame();
        return seconds;
      },
      state() {
        return stateSnapshot();
      },
      /** Cluster metrics: member count, world radius, projected diameter. */
      cluster() {
        const layout = machine.layout;
        if (!layout) return null;
        const diameter = projectedDiameter(
          layout.radius,
          rig.framing().radius,
          camera.fov,
          viewport.h,
        );
        return {
          categoryId: layout.categoryId,
          count: layout.count,
          radius: layout.radius,
          cameraRadius: rig.framing().radius,
          diameterPx: Math.round(diameter),
          diameterPct: Math.round((diameter / viewport.h) * 1000) / 10,
          center: { x: viewport.w / 2, y: viewport.h / 2, w: viewport.w, h: viewport.h },
        };
      },
      enterCluster(categoryId) {
        return enterCluster(categoryId);
      },
      exitCluster(options) {
        return exitCluster(options);
      },
      locate(id) {
        return focusOrSelect(id);
      },
      setUi(ui) {
        setUi(ui);
      },
      /** Force the transition to its end state (verification only). */
      settle() {
        machine.progress = machine.target;
        if (layer) {
          for (let i = 0; i < stations.length; i += 1) layer.setClusterAmount(machine.target);
        }
        applyTransition();
        finishTransition();
        dirty = true;
        requestFrame();
      },
      /**
       * Synchronous render benchmark. requestAnimationFrame is throttled to
       * nothing in a background window, so a wall-clock frame loop would measure
       * the timer, not the scene: this renders N frames back to back and waits
       * for the GPU, and the caller reports the conditions it ran under.
       */
      // eslint-disable-next-line no-unused-vars
      benchmark(frames) {
        const count = Math.max(1, Math.min(240, Math.floor(Number(frames) || 30)));
        const gl = renderer.getContext();
        const pixel = new Uint8Array(4);
        renderer.render(scene, camera);
        // Submission time: how long the CPU spends issuing the frame.
        let start = performance.now();
        for (let i = 0; i < count; i += 1) renderer.render(scene, camera);
        const submitMs = (performance.now() - start) / count;
        // Throughput: queue the whole batch, then wait for it once with a
        // one-pixel read-back. Amortised this is the frame cost; reading every
        // frame would measure the driver's sync overhead instead.
        start = performance.now();
        for (let i = 0; i < count; i += 1) renderer.render(scene, camera);
        if (gl && typeof gl.readPixels === 'function') {
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        }
        const ms = (performance.now() - start) / count;
        const drawn = renderer.info.render;
        const info = gl && typeof gl.getExtension === 'function'
          ? gl.getExtension('WEBGL_debug_renderer_info')
          : null;
        const device = info
          ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
          : gl && typeof gl.getParameter === 'function'
            ? gl.getParameter(gl.RENDERER)
            : 'unknown';
        return {
          frames: count,
          msPerFrame: Math.round(ms * 100) / 100,
          msSubmit: Math.round(submitMs * 100) / 100,
          calls: drawn.calls,
          triangles: drawn.triangles,
          points: drawn.points,
          device: String(device || 'unknown'),
        };
      },
      cameraLimits() {
        return rig.framing();
      },
      center(x, y) {
        const region = centerRegion();
        return { inside: Math.hypot(x - region.x, y - region.y) <= region.r, ...region };
      },
      project(id) {
        const index = idToIndex.get(String(id));
        if (index === undefined) return null;
        const p = projectStation(index);
        return p ? { x: p.x, y: p.y } : null;
      },
      positionOf(id) {
        const index = idToIndex.get(String(id));
        if (index === undefined) return null;
        const s = stations[index];
        return { id: s.id, x: s.position.x, y: s.position.y, z: s.position.z, featured: s.isFeatured === true };
      },
      currentPosition(id) {
        const index = idToIndex.get(String(id));
        if (index === undefined || !layer) return null;
        const point = layer.positionAt(index);
        return { id: stations[index].id, x: point.x, y: point.y, z: point.z };
      },
      hitTest(x, y) {
        const rect = canvas.getBoundingClientRect();
        const index = pick(rect.left + x, rect.top + y);
        return index >= 0 ? stations[index].id : null;
      },
      interactiveIds(limit) {
        const out = [];
        const max = typeof limit === 'number' ? limit : 20;
        for (let i = 0; i < stations.length && out.length < max; i += 1) {
          if (layer && layer.interactive(i)) out.push(stations[i].id);
        }
        return out;
      },
      select(id, selectOptions) {
        const index = idToIndex.get(String(id));
        if (index === undefined) return false;
        return select(index, selectOptions || { focus: true, notify: true });
      },
      focus(id) {
        return handle.focusById(id);
      },
      clear() {
        clearSelection(true);
      },
      reset() {
        handle.resetView();
      },
      framing() {
        return rig.framing();
      },
      holeScreen() {
        const hole = silhouette();
        const region = centerRegion();
        return { x: hole.x, y: hole.y, r: hole.r, region: region.r, w: viewport.w, h: viewport.h };
      },
      cameraPosition() {
        return { x: camera.position.x, y: camera.position.y, z: camera.position.z };
      },
      radioInfo() {
        const uploaded = disk.getRadio();
        return {
          enabled: radio !== null,
          fixtures: handle.radio.fixtures,
          count: uploaded.count,
          mask: uploaded.mask,
          sources: uploaded.sources,
          selected: handle.radio.selected,
          frameVersion: radioState.frameVersion,
          anchors: handle.radio.anchors(),
          extras: radioState.extras || [],
        };
      },
      radioScan() {
        handle.radio.scan();
      },
      radioPick(x, y) {
        return handle.radio.pick(x, y);
      },
      radioSelect(businessId, branch) {
        return handle.radio.select(businessId, branch);
      },
      radioClear() {
        return handle.radio.clear();
      },
      radioProbe(options) {
        return handle.radio.probe(options);
      },
      radioTables() {
        const tables = handle.radio.tables();
        const gl = renderer.getContext();
        const info = tables.info;
        // three keeps the GL name off the texture object; asking the GL context
        // directly needs that handle. `null` means "not uploaded yet", which is
        // not the same as "released" and must not be reported as one.
        const glName = (texture) => {
          try {
            const props = renderer.properties && renderer.properties.get(texture);
            return props && props.__webglTexture ? props.__webglTexture : null;
          } catch {
            return null;
          }
        };
        const alive = (texture) => {
          const name = glName(texture);
          return name ? gl.isTexture(name) : null;
        };
        return {
          hardwareFilter: info.hardwareFilter,
          filterMode: info.filterMode,
          revision: info.revision,
          disposed: tables.disposed,
          deflection: {
            alive: alive(tables.deflection),
            width: info.deflection.width,
            height: info.deflection.height,
          },
          inverseRadius: {
            alive: alive(tables.inverseRadius),
            width: info.inverseRadius.width,
            height: info.inverseRadius.height,
          },
        };
      },
      /**
       * Frame-rate and rendering cost over the last few seconds.
       *
       * `avgFrameMs` / `frameP95` come from the RAW intervals between animation
       * frames, so they are a frame-delivery statistic and can be compared across
       * runs. `renderCpuAvg` is the wall time of renderer.render() on the calling
       * thread — submission cost, NOT GPU time. GPU time is reported separately
       * from EXT_disjoint_timer_query_webgl2 and is null when the driver does not
       * expose it, rather than being guessed at.
       */
      timing() {
        const frames = frameDeltas.length ? frameDeltas.slice() : [];
        const renders = frameTimes.slice();
        let fps = 0;
        let frameP95 = 0;
        let avg = 0;
        if (frames.length) {
          const sum = frames.reduce((acc, value) => acc + value, 0);
          avg = sum / frames.length;
          fps = Math.round((1000 / avg) * 10) / 10;
          const sorted = frames.sort((a, b) => a - b);
          frameP95 = Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 10) / 10;
        }
        let renderCpuAvg = 0;
        let renderCpuP95 = 0;
        if (renders.length) {
          const sorted = renders.slice().sort((a, b) => a - b);
          const sum = sorted.reduce((acc, value) => acc + value, 0);
          renderCpuAvg = Math.round((sum / sorted.length) * 100) / 100;
          renderCpuP95 = Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 100) / 100;
        }
        let gpuAvg = null;
        let gpuP95 = null;
        if (gpuSamples.length) {
          const sorted = gpuSamples.slice().sort((a, b) => a - b);
          const sum = sorted.reduce((acc, value) => acc + value, 0);
          gpuAvg = Math.round((sum / sorted.length) * 100) / 100;
          gpuP95 = Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] * 100) / 100;
        }
        const canvas = renderer.domElement;
        return {
          samples: frames.length,
          fps,
          avgFrameMs: Math.round(avg * 10) / 10,
          frameP95,
          renderCpuAvg,
          renderCpuP95,
          renderAvg: renderCpuAvg,
          renderP95: renderCpuP95,
          pauses: pauseCount,
          gpu: {
            available: Boolean(timerExt),
            samples: gpuSamples.length,
            avgMs: gpuAvg,
            p95Ms: gpuP95,
            disjoint: gpuDisjoint,
          },
          dpr: renderer.getPixelRatio(),
          cssSize: { w: canvas.clientWidth, h: canvas.clientHeight },
          bufferSize: { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight },
          calls: renderer.info.render.calls,
          triangles: renderer.info.render.triangles,
          points: renderer.info.render.points,
        };
      },
      /** Category counts as they are actually distributed in the catalogue. */
      categoryCounts() {
        const counts = new Map();
        for (const station of stations) {
          for (const id of station.categories || []) {
            counts.set(id, (counts.get(id) || 0) + 1);
          }
        }
        return Array.from(counts, ([id, count]) => ({ id, count }));
      },
      /**
       * Run the live imaging shader in a float target and read the packed probe
       * values back. This is how the numerical validator compares its independent
       * reference against the code that actually draws, rather than against a JS
       * re-implementation of it.
       */
      probe(options) {
        return disk.probe(options);
      },
      /** Imaging shader constants and table provenance, for the report. */
      imagingInfo() {
        return disk.getInfo();
      },
    };
    if (typeof window !== 'undefined') {
      window.__BHRL_DEBUG__ = debug;
    }

    notifyMode();
    return handle;
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* best effort while unwinding */
      }
    }
    disposers.length = 0;
    for (const part of parts) {
      try {
        part.dispose();
      } catch {
        /* best effort while unwinding a half-built scene */
      }
    }
    try {
      renderer.dispose();
    } catch {
      /* nothing to release */
    }
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    throw error;
  }
}

/**
 * Whether a pointer sequence is a selection rather than an orbit.
 *
 * A gesture that travelled further than the click slop was a camera drag; a
 * press held longer than the click window is a long press. Exported so the
 * boundary is testable without a browser, and used by the pointer handler so
 * the tested rule is the one that runs.
 */
export function isSelectionGesture(movedPx, heldMs) {
  return Math.abs(Number(movedPx) || 0) <= CLICK_SLOP && (Number(heldMs) || 0) <= PRESS_CLICK_MS;
}

function resolveCatalog(settings) {
  const stations = Array.isArray(settings.stations) ? settings.stations : [];
  const categories =
    Array.isArray(settings.categories) && settings.categories.length > 0
      ? settings.categories
      : summarizeStations(stations);
  return {
    stations,
    categories,
    seed: Number(settings.seed) || 0,
    genres: resolveGenres(settings, stations),
  };
}

/**
 * The visible genres, as the repository already computed them.
 *
 * The host passes `genres` straight from the repository's visible list. When it
 * does not (an older panel, or data that has not arrived), the counts are
 * recovered from the `genreId` the classification layer stamped on each station
 * — still consumed, never re-derived here. An empty result is a valid scene:
 * the stage simply draws no genre gob for it.
 */
function resolveGenres(settings, stations) {
  if (Array.isArray(settings.genres) && settings.genres.length > 0) {
    const out = [];
    const seen = new Set();
    for (const entry of settings.genres) {
      if (!entry || typeof entry.id !== 'string' || !entry.id || seen.has(entry.id)) continue;
      const count = Math.max(0, Math.round(Number(entry.count) || 0));
      if (count <= 0) continue;
      seen.add(entry.id);
      out.push({ id: entry.id, count, color: entry.color });
    }
    return out;
  }
  const buckets = new Map();
  for (const station of stations) {
    const id = station && station.metadata && station.metadata.genreId;
    if (!id || typeof id !== 'string') continue;
    buckets.set(id, (buckets.get(id) || 0) + 1);
  }
  return Array.from(buckets, ([id, count]) => ({ id, count }));
}

function summarizeStations(stations) {
  const buckets = new Map();
  for (const station of stations) {
    const id = station.categories && station.categories[0];
    if (!id) continue;
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { id, count: 0, x: 0, y: 0, z: 0 };
      buckets.set(id, bucket);
    }
    bucket.count += 1;
    bucket.x += station.position ? station.position.x : 0;
    bucket.y += station.position ? station.position.y : 0;
    bucket.z += station.position ? station.position.z : 0;
  }
  return Array.from(buckets.values()).map((bucket) => ({
    id: bucket.id,
    count: bucket.count,
    position: {
      x: bucket.x / bucket.count,
      y: bucket.y / bucket.count,
      z: bucket.z / bucket.count,
    },
  }));
}

function clampRatio(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 2;
  return Math.min(4, Math.max(1, n));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep01(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/**
 * The time at which `smoothstep01` reaches `value`. Exact at both ends: the
 * cubic closed form is a rounding error off there, which is enough to make a
 * resumed transition restart from the wrong side of its endpoint.
 */
function inverseSmoothstep(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return 0.5 - Math.sin(Math.asin(1 - 2 * value) / 3);
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
