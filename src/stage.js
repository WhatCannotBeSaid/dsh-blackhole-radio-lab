/**
 * Black Hole Radio — the lazily loaded WebGL stage (phase 4).
 *
 * This file is the ONLY place three.js is imported. It is bundled by
 * `tools/build-stage.mjs` into a self-contained `client.stage.js` chunk that
 * carries its own copy of three, and that chunk is requested on demand through
 * the harness module system (`require.async('./client.stage.js')`) the first
 * time the panel actually mounts. Nothing here runs at plugin boot.
 *
 * Phase 4 turns the stage into one space with two visual states, not two pages:
 *
 *   black-hole  the hole, photon ring and accretion disk, with the whole
 *               catalogue embedded in the disk's matter field;
 *   cluster     the same stations, reorganised into a true 3-D star cluster,
 *               with the hole's structures faded out and the artist starfield
 *               dimmed behind them.
 *
 * Phase 5 adds a third space: `nebula`, one particle volume per visible genre,
 * held in a single additional Points buffer. It gets its own scalar (`nebula`)
 * for the same reason the cluster has `progress` — a mode is a number, not a
 * page swap — and the camera rig is the same controller with the nebula
 * layout's home and orbit limits. The two transitions never share a value, so
 * switching between them cannot do arithmetic on a half-finished state.
 *
 * Everything between is one continuous state value (`progress`, eased) plus the
 * station layer's per-station blend. Nothing is ever rebuilt: the same scene,
 * the same renderer, the same camera rig, the same Points buffers. That is what
 * makes the transition reversible at any instant — enter and exit animate the
 * same numbers in opposite directions, so an interrupted transition keeps
 * moving from where it is instead of snapping.
 *
 * The interaction machine (single source of truth for the panel):
 *
 *   black-hole ──hold centre──▶ nebula (the genre field)
 *   black-hole ──pick category──▶ transition-to-cluster ──▶ cluster
 *   cluster ──Esc/back──▶ transition-to-black-hole ──▶ black-hole
 *
 * Picking, holding and the keyboard all funnel into this machine; the panel
 * never writes scene state directly.
 */

import {
  ACESFilmicToneMapping,
  Color,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { createAccretionDisk } from './scene/accretion-disk.js';
import { createCameraRig } from './scene/camera-rig.js';
import { createStarfield } from './scene/starfield.js';
import { createWormhole } from './scene/wormhole.js';
import {
  HORIZON_RADIUS,
  CRITICAL_IMPACT_PARAMETER,
  maxOrbitRadiusForShadow,
  shadowAngularRadius,
} from './scene/dimensions.js';
import { categoryLabel } from './radio/taxonomy.js';
import { createStationsLayer } from './nodes/stations-layer.js';
import { createLabelOverlay } from './nodes/label-overlay.js';
import { createHoldRing } from './nodes/hold-ring.js';
import { createRadioOverlay } from './nodes/radio-overlay.js';
import {
  fixtureByGpuId,
  selectRadioFixtures,
  shaderFixtures,
} from './scene/radio-fixtures.js';
import { buildClusterLayout, projectedDiameter } from './cluster/layout.js';
import { buildNebulaLayout, nebulaFramingRadius } from './nebula/layout.js';
import { createNebulaLayer } from './nodes/nebula-layer.js';
import { GENRE_IDS, genreLabel } from './radio/genres.js';

/** Surface this module's phase honestly, in one place. */
export const STAGE_PHASE = 'phase-5';

/** Drags longer than this (CSS px) are camera gestures, never selections. */
const CLICK_SLOP = 6;
/** Hover picking is throttled: a pointer moving across 2,000 dots must not
 * run 2,000 projections per pointer event. */
const HOVER_INTERVAL_MS = 90;
/** Holding the hole's centre this long enters the genre field. */
const LONG_PRESS_MS = 560;
/** A press held longer than this is not a click, whatever else it did. */
const PRESS_CLICK_MS = 800;
/** Progress units per second; the full transition takes ~1.05 s. */
const TRANSITION_RATE = 0.95;

/**
 * The wormhole transition, in seconds from the press.
 *
 * One timeline, not two: the ring fills during the same window the geometry
 * starts to give way, so the horizon is already moving when the ring locks and
 * the distance left after the commit is short. Every segment below is a wall
 * clock reading, so a dropped frame shortens the wait instead of stretching it.
 */
/** Left hold: the ring is full, the transition can no longer be cancelled. */
const WORM_RING_S = 1.2;
/**
 * The shadow has swallowed the whole frame. Same instant as the ring: the fall
 * begins on the press, so by the time the ring locks the frame is already black
 * and everything left is the nebula arriving underneath it.
 */
const WORM_COVER_S = WORM_RING_S;
/** The nebula has finished arriving. */
const WORM_END_S = 1.7;
/** Right hold: the ring is full. */
const WORM_OUT_RING_S = 0.7;
/** The frame is black again, the hole is about to be uncovered. */
const WORM_OUT_VEIL_S = 1.0;
/** The hole is back. */
const WORM_OUT_END_S = 1.6;
/** Movement beyond this many CSS px turns a hold into a camera drag. */
const WORM_DEADZONE_PX = 8;
/** Nebula fade speed while the wormhole drives the reveal (0.5 s). */
const WORM_REVEAL_RATE = 1 / (WORM_END_S - WORM_COVER_S);
/** How long an abandoned hold takes to retreat to where the frame was (ms/s). */
const WORM_RECOIL_S = 0.22;
/** Reduced motion: no wormhole, one 200 ms cross-fade. */
const WORM_CALM_RATE = 1 / 0.2;
/** Catalogue brightness while the hole is the subject. */
const HOLE_STATION_DIM = 0.55;

/** The black-hole camera framing, restored on exit. */
const HOLE_MIN_RADIUS = 6.0;
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
 * @param options.onCenterClick - the hole centre was held (enter the genre field).
 * @returns a handle with selection, mode, camera and measurement helpers.
 */
export function mountStage(container, options) {
  const settings = options || {};
  const antialias = settings.antialias !== false;
  const pixelRatioCap = clampRatio(settings.pixelRatioCap);
  const reducedMotion = settings.reducedMotion === true;
  // The wormhole is the transition. The switch restores the old behaviour —
  // a 560 ms hold that cuts straight to the nebula fade — for A/B comparison
  // and for a rollback that needs no code change.
  const wormholeEnabled = settings.wormhole !== false;
  const language = settings.language === 'en' ? 'en' : 'zh';

  const catalog = resolveCatalog(settings);
  const stations = catalog.stations;
  const categories = catalog.categories;
  // Genre volumes are a render-time input, never a classification: the host
  // hands over the already-counted visible genres from the repository, and the
  // layout only decides where they sit.
  const genres = catalog.genres;
  const nebulaLayout = buildNebulaLayout(genres, { seed: catalog.seed, vocabulary: GENRE_IDS });
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
    if (layer) {
      scene.add(layer.marker);
      // The hole's own image has to win the first glance: the catalogue is
      // still there, but it reads as matter in the disk, not as the subject.
      layer.setDim(HOLE_STATION_DIM);
    }

    const nebula =
      nebulaLayout.genres.length > 0
        ? add(createNebulaLayer(nebulaLayout, { seed: catalog.seed, pixelRatio: ratio, amount: 0 }))
        : null;
    if (nebula) {
      // Hidden until the transition moves: a mount without the preview entry
      // must render exactly the black hole it rendered before phase 5.
      nebula.object.visible = false;
      nebula.setViewport(
        Math.max(1, container.clientWidth),
        Math.max(1, container.clientHeight),
        camera.fov,
      );
    }

    const labels = createLabelOverlay(container);
    disposers.push(() => labels.dispose());

    // The wormhole pass and the ring that feeds it. Both are created even when
    // the switch is off only if the feature is on: with `wormhole: false` the
    // mount is byte-for-byte the old stage, with no extra draw call and no
    // extra DOM.
    const wormholeFx = wormholeEnabled ? add(createWormhole()) : null;
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
    const focusTarget = new Vector3();
    const selectedStation = () => (selectedIndex >= 0 ? stations[selectedIndex] : null);

    let labelCategories = buildLabelCategories(categories, language);
    let labelLanguage = language;
    const labelPoint = new Vector3();

    /**
     * The one interaction machine. `mode` and `ui` are deliberately separate:
     * search and the category panel are overlays on the hole state, while mode
     * describes which space the camera and scene are in.
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
      /** Selected genre in the nebula space; null means no volume selected. */
      genreId: null,
      /** Nebula fade, 0..1. `nebulaTarget` is where it is heading. */
      nebula: 0,
      nebulaTarget: 0,
      nebulaSavedCamera: null,
      /**
       * The hole is gone from the frame even though the nebula is still faint.
       * The wormhole needs those two states to be separate for its last 500 ms:
       * the black has already swallowed the image while the dust is still
       * arriving, so the disk must not reappear under the fading mask.
       */
      wormCover: 0,
    };
    const layoutCache = new Map();
    let lastModeKey = '';
    let transitioning = false;
    let nebulaMoving = false;
    /**
     * How fast the nebula scalar climbs. Its own number because the wormhole
     * reveals the nebula in 500 ms while the old cross-fade took 1.28 s, and the
     * integrator should not have to know which gesture started it.
     */
    let nebulaSpeed = TRANSITION_RATE * 0.82;
    // Last fit distance authored for the nebula shell, so a resize can preserve
    // the user's zoom level instead of snapping back to the default framing.
    let nebulaFit = 0;
    let hoverNebulaIndex = -1;
    const nebulaPoint = new Vector3();

    /** Index of the selected genre inside the layout, or -1. */
    const nebulaIndex = () => {
      if (!nebula || !machine.genreId) return -1;
      return nebulaLayout.genres.findIndex((volume) => volume.id === machine.genreId);
    };

    /**
     * The genre palette as CSS. Kept near-opaque so a label stays readable, but
     * it is the volume's own colour, not a second light source.
     */
    const nebulaCss = (color) =>
      `rgba(${Math.round(Math.min(1, color[0]) * 255)}, ${Math.round(Math.min(1, color[1]) * 255)}, ${Math.round(Math.min(1, color[2]) * 255)}, 0.95)`;

    /**
     * Pick a volume under a pointer position.
     *
     * The hit test runs against each volume's padded sphere, never the
     * particles: 26,000 dust motes cannot be projected per pointer move, and the
     * sphere is the shape the eye is already reading.
     */
    const pickNebulaAt = (clientX, clientY) => {
      if (!nebula || machine.mode !== 'nebula') return null;
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      if (px < 0 || py < 0 || px > viewport.w || py > viewport.h) return null;
      camera.updateMatrixWorld();
      const hit = nebula.pick(camera, (px / viewport.w) * 2 - 1, 1 - (py / viewport.h) * 2);
      return hit && hit.index >= 0 ? hit : null;
    };

    const setNebulaHover = (index) => {
      const next = Number.isInteger(index) && index >= 0 ? index : -1;
      if (next === hoverNebulaIndex) return;
      hoverNebulaIndex = next;
      if (nebula) {
        nebula.setHover(next, 1);
        if (reducedMotion) nebula.update(1 / 60, { instant: true });
      }
      canvas.style.cursor = next >= 0 ? 'pointer' : 'grab';
      dirty = true;
      requestFrame();
    };

    /**
     * Select a genre. This is the stable hook phase 4 needs: the selection lives
     * in the machine, is mirrored into the layer's uniforms and is reported to
     * the host through `onGenreChange`, but nothing here enters a cluster.
     */
    const setGenre = (id, options) => {
      const opts = options || {};
      const next = typeof id === 'string' && id ? id : null;
      const changed = next !== machine.genreId;
      machine.genreId = next;
      if (nebula) {
        nebula.setSelected(next ? nebulaIndex() : -1);
        dirty = true;
        requestFrame();
      }
      if (changed) {
        notifyMode();
        if (!opts.silent && typeof settings.onGenreChange === 'function') {
          try {
            settings.onGenreChange(next);
          } catch {
            /* a panel bug must not stop the scene */
          }
        }
      }
      return changed;
    };

    /**
     * The label payload for the nebula space: one entry per visible genre.
     * Occlusion is decided here against the same padded spheres picking uses, so
     * a label cannot float on top of the volume that is hiding it.
     */
    const nebulaLabels = () => {
      if (!nebula) return [];
      const selected = nebulaIndex();
      const entries = [];
      for (const volume of nebulaLayout.genres) {
        projected.set(volume.center.x, volume.center.y, volume.center.z).project(camera);
        if (projected.z < -1 || projected.z > 1) continue;
        const x = (projected.x * 0.5 + 0.5) * viewport.w;
        const y = (0.5 - projected.y * 0.5) * viewport.h;
        nebulaPoint.set(volume.center.x, volume.center.y, volume.center.z);
        const distance = camera.position.distanceTo(nebulaPoint);
        camera.updateMatrixWorld();
        const probe = nebula.pick(camera, (x / viewport.w) * 2 - 1, 1 - (y / viewport.h) * 2);
        const occluded = Boolean(
          probe && probe.index !== volume.index && probe.near < distance - volume.radius * 0.55,
        );
        entries.push({
          id: volume.id,
          index: volume.index,
          label: genreLabel(volume.id, labelLanguage) || volume.id,
          count: volume.count,
          position: volume.center,
          x,
          y,
          color: nebulaCss(volume.color),
          radiusPx: nebula.radiusPx(volume.index, camera, viewport.h),
          hovered: volume.index === hoverNebulaIndex,
          selected: volume.index === selected,
          occluded,
          distance,
        });
      }
      // Nearest first: the closest volume gets the first claim on a label slot.
      entries.sort((a, b) => a.distance - b.distance);
      return entries;
    };

    /** The distance the shell needs at this box, so a narrow window still fits. */
    const nebulaFitRadius = (w, h, fov) => nebulaFramingRadius(nebulaLayout.extent, w, h, fov);

    /**
     * One source of truth for the nebula dolly range.
     *
     * The fit distance is the authored view, not a boundary: the floor has to
     * stay below it or the wheel has nowhere to go, and the ceiling has to stay
     * above it or the shell collapses to dust on the first scroll out.
     */
    const nebulaLimits = () => {
      const fit = nebulaFitRadius(viewport.w, viewport.h, camera.fov);
      return {
        fit,
        minRadius: Math.max(26, Math.min(nebulaLayout.camera.minRadius, fit * 0.62)),
        maxRadius: Math.min(300, Math.max(nebulaLayout.camera.maxRadius, fit * 1.45)),
      };
    };

    /**
     * Keep the shell framed after a resize without re-authoring the view: the
     * angles and the user's zoom level survive, only the distance moves. A
     * portrait box needs a wider shell on screen, so the home distance follows
     * the box instead of staying at the distance authored for the old one.
     */
    const applyNebulaFraming = () => {
      if (!nebula || machine.nebulaTarget < 0.5) return;
      const limits = nebulaLimits();
      const framing = rig.framing();
      const previous = nebulaFit;
      nebulaFit = limits.fit;
      // No previous fit means this is the entry frame, not a resize: the authored
      // distance wins and no zoom ratio is applied.
      const zoom = previous > 0 ? Math.min(1.6, Math.max(0.55, framing.radius / previous)) : 1;
      rig.setLimits({ minRadius: limits.minRadius, maxRadius: limits.maxRadius });
      rig.setHome({
        radius: Math.min(limits.maxRadius, Math.max(limits.minRadius, limits.fit * zoom)),
        phi: framing.home.phi,
        theta: framing.home.theta,
        target: framing.home.target,
        minRadius: limits.minRadius,
        maxRadius: limits.maxRadius,
      });
    };

    const positionOf = (index) => {
      if (layer) layer.positionInto(index, labelPoint);
      else if (stations[index] && stations[index].position) {
        labelPoint.set(stations[index].position.x, stations[index].position.y, stations[index].position.z);
      }
      return labelPoint;
    };

    const revealedClouds = () => {
      if (!layer || machine.progress > 0.05) return [];
      const info = layer.filterInfo();
      if (!info.active || info.clouds.length === 0) return [];
      const seen = new Set();
      const out = [];
      for (const cloud of info.clouds) {
        if (seen.has(cloud.categoryId)) continue;
        seen.add(cloud.categoryId);
        out.push({
          id: cloud.id,
          label: categoryLabel(cloud.categoryId, labelLanguage),
          count: cloud.count,
          position: cloud.position,
        });
      }
      return out;
    };

    const applySize = () => {
      const rect = container.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (w === viewport.w && h === viewport.h) return false;
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
      starfield.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
      if (layer) {
        layer.setPixelRatio(renderer.getPixelRatio());
        layer.setViewport(w, h, camera.fov);
      }
      labels.resize(w, h, renderer.getPixelRatio());
      if (radio) radio.resize(w, h, renderer.getPixelRatio());
      if (wormholeFx) wormholeFx.setViewport(w, h);
      if (nebula) {
        nebula.setPixelRatio(renderer.getPixelRatio());
        nebula.setViewport(w, h, camera.fov);
        applyNebulaFraming();
      }
      // The hole's far limit is a property of the box, not a constant: opening
      // the sidebar narrows the canvas, and a ceiling authored for the full
      // window would let the shadow fall below its size floor there. A cluster
      // keeps the limit its own layout authored, so only the hole is refitted.
      if (machine.target < 0.5 && machine.nebulaTarget < 0.5 && machine.mode === 'black-hole') {
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
      const rise = smoothstep01(machine.progress);
      const nebulaRise = smoothstep01(machine.nebula);
      // Whichever space is taking over drives the hole out. The hole leaves a
      // little after the content starts moving, and returns a little before it
      // arrives: the matter should look reorganised, not cross-faded.
      // `wormCover` is the third source: the wormhole has already swallowed the
      // frame, so the hole is gone even while the nebula is still at zero.
      const cover = clamp01(machine.wormCover);
      const leaving = Math.max(rise, nebulaRise, cover);
      const holeFade = smoothstep01(clamp01((leaving - 0.05) / 0.72));
      disk.setOpacity(1 - holeFade);
      // Kept so this call site need not know that the analytic ring is gone:
      // the imaging pass draws the ring where the winding piles up, itself.
      disk.setRingIntensity(0.62 * (1 - holeFade));
      // The starfield stays as the deep background in the nebula space: the
      // camera sits inside its outer shells there, and empty black around the
      // volumes reads as a missing backdrop, not as space.
      starfield.setDim(Math.max(rise, nebulaRise * 0.55, cover * 0.55));
      if (layer) {
        layer.setClusterAmount(rise);
        // Per frame this is overwritten in the loop with the live progress; the
        // value here only has to be right for the call itself.
        layer.setHoleOnly(1 - machine.progress);
      }
      if (nebula) {
        nebula.object.visible = nebulaRise > 0.001;
        nebula.setAmount(nebulaRise);
      }
      if (rise > 0.001 || nebulaRise > 0.001 || cover > 0.001) dirty = true;
    };

    /**
     * The nebula fade reached its destination. Mode changes only now, so every
     * pointer path keeps operating on the space that is actually on screen.
     */
    const finishNebulaTransition = () => {
      nebulaMoving = false;
      // Back to the house rate: only a wormhole-reveal is fast.
      nebulaSpeed = TRANSITION_RATE * 0.82;
      if (machine.nebulaTarget > 0.5) {
        machine.mode = 'nebula';
      } else {
        machine.mode = 'black-hole';
        machine.ui = 'black-hole';
        hoverNebulaIndex = -1;
        if (nebula) nebula.setHover(-1, 0);
      }
      syncDataset();
      notifyMode();
    };

    const frameTimes = [];
    const frameDeltas = [];
    let pauseCount = 0;

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
      const labelReveal = machine.progress;
      // The labels are their own 2D canvas stacked above the WebGL one, so the
      // mask can never cover them. They have to fade with it instead, or the
      // names hang in front of a black frame as if they were a mistake.
      const maskAlpha = clamp01(worm.alpha);
      const nebulaReveal = smoothstep01(machine.nebula) * (1 - maskAlpha);
      if (nebulaReveal > 0.02) {
        // The nebula space names its volumes and nothing else: no station names,
        // no category legend, and no hole keep-out (the hole is not drawn).
        labels.draw({
          camera,
          lod: 0,
          stations: [],
          categories: [],
          selectedIndex: -1,
          hole: null,
          visibilityAt: () => 0,
          positionAt: () => null,
          clouds: [],
          cloudStrength: 0,
          cluster: 0,
          nebulae: nebulaLabels(),
          nebulaFade: nebulaReveal,
        });
      } else if (layer) {
        const info = layer.filterInfo();
        // The label overlay follows the same rule: black-hole mode draws none.
        // It is still created, resized and disposed exactly as before.
        if (labelReveal > 0.02) {
          labels.draw({
            camera,
            lod: currentLod,
            stations,
            categories: labelCategories,
            selectedIndex,
            hole: silhouette(),
            visibilityAt: (index) => layer.labelVisibility(index),
            positionAt: positionOf,
            clouds: revealedClouds(),
            cloudStrength: info.strength,
            cluster: machine.progress,
          });
        } else {
          labels.clear();
        }
      } else {
        labels.clear();
      }
      // Fixture labels last: they sit above the station names by design, but
      // only in the space they belong to. A nebula frame carries no fixtures.
      if (nebulaReveal > 0.02) {
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

      const moved = rig.update(dt);
      if (moved) dirty = true;

      // Advance the one transition value. Reversing simply flips the sign of
      // this climb; no queue, no competing tween.
      if (machine.progress !== machine.target) {
        const delta = machine.target - machine.progress;
        const step = TRANSITION_RATE * dt;
        machine.progress += Math.sign(delta) * Math.min(Math.abs(delta), step);
        if (Math.abs(machine.target - machine.progress) < 1e-4) machine.progress = machine.target;
        transitioning = machine.progress !== machine.target;
        applyTransition();
        dirty = true;
        if (!transitioning) finishTransition();
      }

      // The nebula fade. Deliberately its own value: entering the nebula never
      // touches the cluster's progress, so an interrupted cluster transition
      // cannot be mistaken for part of this one.
      // A running wormhole owns the nebula value (see driveNebula): integrating
      // a rate here as well would put the dust on a second, slower clock.
      if (!worm.kind && machine.nebula !== machine.nebulaTarget) {
        const delta = machine.nebulaTarget - machine.nebula;
        const step = nebulaSpeed * dt;
        machine.nebula += Math.sign(delta) * Math.min(Math.abs(delta), step);
        if (Math.abs(machine.nebulaTarget - machine.nebula) < 1e-4) {
          machine.nebula = machine.nebulaTarget;
        }
        nebulaMoving = machine.nebula !== machine.nebulaTarget;
        applyTransition();
        dirty = true;
        if (!nebulaMoving) finishNebulaTransition();
      }

      if (!reducedMotion) {
        elapsed += dt;
        starfield.update(elapsed, dt);
        dirty = true;
      }

      currentLod = computeLod();
      if (layer) {
        layer.setLod(currentLod);
        const hole = silhouette();
        layer.setHole(hole.x, hole.y, hole.r * 1.02);
        // Phase 5 accepts the hole on its own. In black-hole mode the catalogue
        // sprites and the selection marker are hidden so nothing competes with
        // the imaging result; cluster mode restores them untouched. Positions,
        // ids, search and layout all keep running underneath.
        layer.setHoleOnly(1 - machine.progress);
        if (layer.update(dt, camera, viewport.h)) dirty = true;
      }

      disk.update(elapsed, camera);

      if (nebula && (nebula.amount > 0.001 || nebula.isEmphasised)) {
        nebula.update(dt, { paused: reducedMotion });
        if (!reducedMotion) dirty = true;
      }

      // The hold goes last: it reads the hole and the camera as they are this
      // frame, and on its way to the end it may hand the transition to the
      // nebula, which then integrates from the following frame on.
      advanceWormhole(now);

      if (dirty) draw();
      const morphing = layer ? layer.isAnimating : false;
      const nebulaDrift = nebula ? nebula.amount > 0.001 && !reducedMotion : false;
      if (
        !reducedMotion ||
        moved ||
        morphing ||
        transitioning ||
        nebulaMoving ||
        nebulaDrift ||
        worm.kind
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

      let best = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < stations.length; index += 1) {
        if (!layer.interactive(index)) continue;
        const p = projectStation(index);
        if (!p) continue;
        const size = layer.screenSizeAt(index, camera, viewport.h);
        // In the cluster a click has to resolve one star among a dense core, so
        // the radius grows a little; it still cannot reach a neighbour's centre.
        const threshold = Math.max(machine.progress > 0.5 ? 9 : 10, Math.min(34, size * 1.15 + 8));
        const distance = Math.hypot(p.x - px, p.y - py);
        if (distance <= threshold && distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      return best;
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
      if (selectedId) canvas.setAttribute('data-bhrl-selected', selectedId);
      else canvas.removeAttribute('data-bhrl-selected');
      canvas.setAttribute('data-bhrl-mode', machine.mode);
      if (machine.genreId) canvas.setAttribute('data-bhrl-genre', machine.genreId);
      else canvas.removeAttribute('data-bhrl-genre');
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
      const movingNebula = machine.nebula !== machine.nebulaTarget;
      const state = transitioning
        ? machine.target > 0.5
          ? 'transition-to-cluster'
          : 'transition-to-black-hole'
        : movingNebula
          ? machine.nebulaTarget > 0.5
            ? 'transition-to-nebula'
            : 'transition-to-black-hole'
          : machine.mode === 'cluster'
            ? 'cluster'
            : machine.mode === 'nebula'
              ? 'nebula'
              : machine.ui;
      const tn = Math.round(smoothstep01(machine.nebula) * 1000) / 1000;
      return {
        state,
        mode: machine.mode,
        ui: machine.ui,
        categoryId: machine.categoryId,
        genreId: machine.genreId,
        progress: Math.round(machine.progress * 1000) / 1000,
        // The two reserved scalars of the phase-1 design: `tn` is how much of
        // the nebula space is present, `tc` how much of a genre cluster is.
        // `tc` stays a constant 0 until phase 4 wires the genre → cluster leg.
        tn,
        tc: Math.round(smoothstep01(machine.progress) * 1000) / 1000,
        transitioning: transitioning || movingNebula,
        stations: stations.length,
        nebulae: nebulaLayout.genres.length,
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
      const id = String(categoryId || '');
      if (!id || !layer) return false;
      if (machine.mode === 'cluster' && machine.categoryId === id && machine.target === 1) return true;
      let layout = layoutCache.get(id);
      if (!layout) {
        layout = buildClusterLayout(stations, { seed: catalog.seed, categoryId: id });
        layoutCache.set(id, layout);
      }
      if (machine.mode !== 'cluster' && machine.target < 0.5) {
        machine.savedCamera = rig.framing();
        clearSelection(true);
      }
      clearTimers();
      machine.categoryId = id;
      machine.layout = layout;
      machine.ui = 'black-hole';
      machine.target = 1;
      if (machine.progress > 0.999) machine.progress = 0.999;
      transitioning = true;
      layer.setCluster(layout);
      rig.setHome({
        radius: layout.camera.radius,
        phi: layout.camera.phi,
        theta: layout.camera.theta,
        minRadius: layout.minRadius,
        maxRadius: layout.maxRadius,
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

    /**
     * Enter the nebula space. The cluster state is dropped rather than faded:
     * the two spaces do not share a shot, and phase 4 owns the real genre →
     * cluster leg. `options.genreId` selects a volume on arrival.
     */
    const enterNebula = (enterOptions) => {
      const opts = enterOptions || {};
      if (!nebula) return false;
      if (machine.mode === 'nebula' && machine.nebulaTarget === 1) {
        if (opts.genreId) setGenre(String(opts.genreId));
        return true;
      }
      if (machine.nebulaTarget < 0.5) machine.nebulaSavedCamera = rig.framing();
      clearTimers();
      clearSelection(false);
      if (machine.mode === 'cluster' || machine.progress > 0) {
        // Leaving a cluster mid-transition: reset its scalar so the same tick
        // cannot keep advancing stations nobody is looking at.
        if (layer) layer.setCluster(null);
        machine.progress = 0;
        machine.target = 0;
        machine.mode = 'black-hole';
        machine.categoryId = null;
        machine.layout = null;
        transitioning = false;
      }
      machine.ui = 'black-hole';
      machine.mode = 'nebula';
      machine.nebulaTarget = 1;
      if (machine.nebula > 0.999) machine.nebula = 0.999;
      if (opts.genreId) setGenre(String(opts.genreId));
      const limits = nebulaLimits();
      rig.setHome({
        radius: limits.fit,
        phi: nebulaLayout.camera.phi,
        theta: nebulaLayout.camera.theta,
        minRadius: limits.minRadius,
        maxRadius: limits.maxRadius,
      });
      nebulaFit = limits.fit;
      applyTransition();
      syncDataset();
      dirty = true;
      requestFrame();
      notifyMode();
      return true;
    };

    /** Return to the hole, restoring the framing the user left. */
    const exitNebula = (exitOptions) => {
      const opts = exitOptions || {};
      if (!nebula) return false;
      if (machine.nebulaTarget === 0 && machine.mode === 'black-hole') return true;
      clearTimers();
      // The chosen genre is left in place on purpose: coming back to the nebula
      // space should restore where the user was, not the default framing. The
      // highlight travels with it, which is invisible while the nebula is out.
      machine.nebulaTarget = 0;
      machine.mode = 'black-hole';
      machine.ui = 'black-hole';
      const saved = machine.nebulaSavedCamera;
      machine.nebulaSavedCamera = null;
      const limits = holeOrbitLimits();
      rig.setHome({
        radius: saved && Number.isFinite(saved.radius) ? saved.radius : undefined,
        phi: saved && Number.isFinite(saved.phi) ? saved.phi : undefined,
        theta: saved && Number.isFinite(saved.theta) ? saved.theta : undefined,
        minRadius: limits.minRadius,
        maxRadius: limits.maxRadius,
      });
      applyTransition();
      syncDataset();
      dirty = true;
      requestFrame();
      notifyMode();
      return opts.instant === true ? true : true;
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
    // being pushed ('enter' from the hole, 'exit' from the nebula), `startedAt`
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
    };

    /** The hold ring and the wormhole pass are both optional by switch. */
    const vfx = reducedMotion ? null : wormholeFx;

    /** Where the shadow is, in the coordinates the overlay wants. */
    const wormFrame = () => {
      const hole = silhouette();
      const w = Math.max(1, viewport.w);
      const h = Math.max(1, viewport.h);
      const aspect = w / h;
      return {
        center: { x: hole.x / w, y: 1 - hole.y / h },
        shadow: hole.r / h,
        // The radius that covers the farthest corner, plus a margin so the
        // frame is black before anything behind the mask is allowed to change.
        cover: Math.sqrt(aspect * aspect + 1) * 0.5 + 0.12,
      };
    };

    const ringPoint = (event) => {
      const rect = container.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const startHold = (kind, event) => {
      // One hold at a time, ever. A second press mid-transition would overwrite
      // the timeline of the first and leave the mask half drawn. A recoil is not
      // a hold: it is only the cancel fading out, so a new press may cut it off.
      if (worm.kind && worm.kind !== 'recoil') return;
      // No nebula layer means nowhere to fly to: stay on the hole and leave the
      // old long press to do whatever it did. Checked before the recoil is
      // dropped, so a refused start leaves nothing half cleared behind it.
      if (kind === 'enter' && !nebula) return;
      // Taking a recoil back up resumes from the phase that is on screen, not
      // from zero: the press picks the fall up where the cancel left it, so the
      // mask neither jumps back to the shadow nor forward to the lock.
      let resumeAt = 0;
      if (worm.kind === 'recoil' && worm.phase) {
        const f = wormFrame();
        if (kind === 'exit') {
          const e = worm.phase.alpha / 0.45;
          if (e > 0.02) resumeAt = Math.pow(clamp01(e), 1 / 0.72) * WORM_OUT_RING_S;
        } else {
          const span = f.cover - f.shadow;
          const u = span > 1e-4 ? clamp01((worm.phase.radius - f.shadow) / span) : 0;
          if (u > 0.004) resumeAt = Math.pow(u, 1 / 1.3) * WORM_COVER_S;
        }
      }
      if (worm.kind === 'recoil') {
        worm.phase = null;
        worm.from = null;
        worm.alpha = 0;
        if (vfx) vfx.reset();
      }
      const p = ringPoint(event);
      worm.kind = kind;
      worm.locked = false;
      worm.covered = false;
      worm.veiled = false;
      worm.phase = null;
      worm.from = null;
      worm.alpha = 0;
      worm.hiddenAt = 0;
      worm.pointerId = event.pointerId;
      worm.button = event.button === 2 ? 2 : 0;
      worm.startedAt = performance.now() - resumeAt * 1000;
      worm.downX = event.clientX;
      worm.downY = event.clientY;
      worm.cursorX = p.x;
      worm.cursorY = p.y;
      if (holdRing) {
        holdRing.show(p.x, p.y);
        holdRing.setProgress(0, p.x, p.y);
      }
      dirty = true;
      requestFrame();
    };

    /**
     * Throw the hold away. The frame is already part way through the fall — the
     * mask has been growing since the press — so the cancel is a short recoil
     * back to where the frame stood, not a cut. That is `WORM_RECOIL_S` of
     * damped retreat instead of a jump the eye would catch.
     */
    const cancelHold = () => {
      if (!worm.kind || worm.kind === 'recoil') return;
      const recoiling = vfx && worm.phase && (worm.alpha > 0.004 || worm.phase.streak > 0.004);
      worm.locked = false;
      worm.covered = false;
      worm.veiled = false;
      worm.hiddenAt = 0;
      worm.pointerId = -1;
      worm.button = 0;
      if (holdRing) holdRing.hide();
      if (recoiling) {
        // Retreated from the phase that is on screen right now, so the curve
        // starts where the eye left it rather than where the last frame ended.
        // Remember which direction the retreat must run: the fall grew into the
        // frame, the exit only thickened a veil over it, and the two have
        // different paths back.
        const retreatKind = worm.kind === 'exit' ? 'exit' : 'enter';
        worm.kind = 'recoil';
        worm.from = { ...worm.phase, kind: retreatKind };
        worm.startedAt = performance.now();
      } else {
        worm.kind = null;
        worm.phase = null;
        worm.from = null;
        worm.alpha = 0;
        if (vfx) vfx.reset();
      }
      dirty = true;
      requestFrame();
    };

    /** The hold committed: from here the timeline cannot be stopped. */
    const lockHold = () => {
      if (worm.locked) return;
      worm.locked = true;
      if (holdRing) holdRing.complete();
      if (worm.kind === 'enter') {
        if (reducedMotion) {
          // No wormhole: the ring is the whole feedback, then one short fade.
          nebulaSpeed = WORM_CALM_RATE;
          enterNebula();
          cancelHold();
        }
        return;
      }
      // Leaving the nebula. Cover the frame before the nebula is allowed to
      // sink, so the hole cannot flash through the fade on its way back.
      if (reducedMotion) {
        nebulaSpeed = WORM_CALM_RATE;
        exitNebula({});
        cancelHold();
        return;
      }
      machine.wormCover = 1;
      nebulaSpeed = WORM_REVEAL_RATE;
      exitNebula({});
    };

    /**
     * The frame is black. Hand the transition to the nebula: the dust arrives
     * underneath the still-opaque mask, so the reveal is the mask fading and not
     * a cross-fade between two pictures.
     */
    const beginCover = () => {
      machine.wormCover = 1;
      nebulaSpeed = WORM_REVEAL_RATE;
      // The host is told at the moment the space actually changes, exactly as
      // the old centre hold told it. Its handler calls enterNebula(); if the
      // host has no handler the transition starts here instead.
      if (typeof settings.onCenterClick === 'function') {
        try {
          settings.onCenterClick();
        } catch {
          /* ignore */
        }
      }
      if (machine.nebulaTarget < 0.5) enterNebula();
    };

    const finishWormhole = () => {
      if (worm.kind === 'enter') {
        // Land exactly on the end state rather than a frame short of it.
        if (machine.nebulaTarget < 0.5) enterNebula();
        machine.nebula = 1;
      } else {
        machine.nebula = 0;
      }
      machine.wormCover = 0;
      nebulaSpeed = TRANSITION_RATE * 0.82;
      applyTransition();
      finishNebulaTransition();
      if (vfx) vfx.reset();
      if (holdRing) holdRing.hide();
      worm.kind = null;
      worm.locked = false;
      worm.covered = false;
      worm.phase = null;
      worm.from = null;
      worm.veiled = false;
      worm.alpha = 0;
      worm.hiddenAt = 0;
      worm.pointerId = -1;
      worm.button = 0;
      dirty = true;
      requestFrame();
    };

    /** A second right press mid-exit: land now instead of waiting. */
    const skipWormhole = () => {
      // Only a running exit can be landed early. Skipping an entry would drop
      // its commit, and skipping before the lock would jump the ring itself.
      if (!worm.kind || worm.kind !== 'exit' || !worm.locked) return false;
      worm.startedAt -= 10 * 1000;
      requestFrame();
      return true;
    };

    /**
     * Write the nebula value straight from the hold's timeline.
     *
     * The nebula used to integrate a rate against the frame delta, which is fine
     * for a fade the user cannot see through but wrong here: the mask and the
     * dust have to arrive at the same instant, at any frame rate. Driven from
     * the wall clock, a dropped frame shortens the animation instead of making
     * the two halves drift apart.
     */
    const driveNebula = (value) => {
      const next = clamp01(value);
      if (Math.abs(next - machine.nebula) < 1e-4) return;
      machine.nebula = next;
      applyTransition();
      dirty = true;
    };

    /**
     * Advance the one hold. Called from the frame loop; returns whether a frame
     * is still owed. Every branch reads the wall clock, so the timeline is the
     * same length whatever the frame rate was.
     */
    const advanceWormhole = (now) => {
      if (!worm.kind) return false;
      // A hidden page keeps no time. Freezing the timeline here is what makes the
      // give-back in onFocus honest: without it the compensation would rewind the
      // transition by the time the frames kept running.
      if (worm.hiddenAt) return true;
      const t = (now - worm.startedAt) / 1000;

      // A cancelled hold retreats along the path it took in. Short, damped, and
      // it starts from the exact phase that was on screen when the press ended.
      if (worm.kind === 'recoil') {
        const e = smoothstep01(clamp01(1 - t / WORM_RECOIL_S));
        const frame = wormFrame();
        const from = worm.from;
        if (vfx && from) {
          const veiling = from.kind === 'exit';
          // The fall grew into the frame, so its retreat gives the radius back
          // and stays opaque until the last third, where it hands over to the
          // shadow at rest. The exit never grew: it only laid a veil over a frame
          // that was already covered, so its retreat has no radius to return and
          // simply lifts the veil where it stands.
          const radius = veiling ? from.radius : frame.shadow + (from.radius - frame.shadow) * e;
          const alpha = veiling
            ? from.alpha * e
            : from.alpha * smoothstep01(clamp01(e / 0.3));
          const streak = from.streak * e;
          const rim = from.rim * e;
          vfx.setPhase({ center: frame.center, radius, alpha, streak, rim });
          vfx.update(0.016);
          // Kept live so a capture (and the cancel's own "did it draw yet?" test)
          // sees what is really on screen during the retreat.
          worm.phase = { radius, alpha, streak, rim };
          worm.alpha = alpha;
        } else {
          worm.alpha = 0;
        }
        dirty = true;
        if (t >= WORM_RECOIL_S) {
          worm.kind = null;
          worm.phase = null;
          worm.from = null;
          worm.alpha = 0;
          if (vfx) vfx.reset();
        }
        return true;
      }

      if (worm.kind === 'enter') {
        // The ring, up to the commit.
        if (t < WORM_RING_S) {
          if (holdRing) holdRing.setProgress(clamp01(t / WORM_RING_S), worm.cursorX, worm.cursorY);
        } else if (!worm.locked) {
          lockHold();
          if (!worm.kind) return false; // reduced motion has already finished
        }
        if (t >= WORM_COVER_S && !worm.covered) {
          worm.covered = true;
          beginCover();
        }
        if (t >= WORM_COVER_S) {
          // The dust rises underneath the mask, on this same clock.
          driveNebula(smoothstep01(clamp01((t - WORM_COVER_S) / (WORM_END_S - WORM_COVER_S))));
        }
        if (t >= WORM_END_S) {
          finishWormhole();
          return false;
        }
        if (vfx) {
          const frame = wormFrame();
          let radius = frame.shadow;
          let alpha = 0;
          let streak = 0;
          let rim = 0;
          if (t < WORM_COVER_S) {
            // The fall starts on the press, not on the commit: the shadow swells
            // from the first frame of the ring, so the hold is travel rather than
            // a countdown. The mask opens exactly on the shadow's own radius,
            // which is why beginning here costs no pop and needs no flash frame.
            // The curve leans backwards on purpose — the horizon widens at once
            // but full coverage still lands on the lock, not half way there.
            const u = clamp01(t / WORM_COVER_S);
            const e = Math.pow(u, 1.3);
            radius = frame.shadow + (frame.cover - frame.shadow) * e;
            alpha = smoothstep01(clamp01(u / 0.18));
            // A soft halo is on the edge from the first frame, so the press is
            // answered before anything else has happened.
            streak = 0.25 + 0.75 * e;
            rim = 0.25 + 0.75 * e;
          } else {
            // The frame is black. What is left is the mask giving way as the dust
            // arrives underneath it, on the same clock.
            radius = frame.cover;
            const v = clamp01((t - WORM_COVER_S) / (WORM_END_S - WORM_COVER_S));
            alpha = 1 - smoothstep01(clamp01(v / 0.62));
            // The light goes first: by half way through the reveal the frame is
            // the nebula and nothing else, so no ray is left crossing it.
            const gone = 1 - smoothstep01(clamp01(v / 0.4));
            streak = gone;
            rim = gone;
          }
          vfx.setPhase({
            center: frame.center,
            radius,
            alpha,
            streak,
            rim,
          });
          worm.phase = { radius, alpha, streak, rim };
          worm.alpha = alpha;
        }
        if (vfx) vfx.update(0.016);
        dirty = true;
        return true;
      }

      // Leaving the nebula.
      if (t < WORM_OUT_RING_S) {
        if (holdRing) holdRing.setProgress(clamp01(t / WORM_OUT_RING_S), worm.cursorX, worm.cursorY);
      } else if (!worm.locked) {
        lockHold();
        if (!worm.kind) return false;
      }
      // The mask is opaque at the end of the veil: drop the cover behind it.
      if (t >= WORM_OUT_VEIL_S - 0.02 && !worm.veiled) {
        worm.veiled = true;
        machine.wormCover = 0;
        applyTransition();
      }
      if (t >= WORM_OUT_RING_S) {
        // The dust sinks on the same clock as the veil coming down.
        driveNebula(1 - smoothstep01(clamp01((t - WORM_OUT_RING_S) / (WORM_OUT_VEIL_S - WORM_OUT_RING_S))));
      }
      if (t >= WORM_OUT_END_S) {
        finishWormhole();
        return false;
      }
      if (vfx) {
        const frame = wormFrame();
        let radius = frame.cover;
        let alpha = 0;
        let streak = 0;
        let rim = 0;
        if (t < WORM_OUT_RING_S) {
          // Same rule on the way out: the curtain starts closing on the press, so
          // the nebula dims while the ring fills instead of waiting for it.
          const e = Math.pow(clamp01(t / WORM_OUT_RING_S), 0.72);
          alpha = 0.45 * e;
          streak = 0.16 * e;
          rim = 0.12 * e;
        } else if (t < WORM_OUT_VEIL_S) {
          const e = smoothstep01(clamp01((t - WORM_OUT_RING_S) / (WORM_OUT_VEIL_S - WORM_OUT_RING_S)));
          radius = frame.cover;
          alpha = 0.45 + 0.55 * e;
          streak = 0.16 + 0.19 * e;
          rim = 0.12 + 0.13 * e;
        } else {
          const u = clamp01((t - WORM_OUT_VEIL_S) / (WORM_OUT_END_S - WORM_OUT_VEIL_S));
          const e = smoothstep01(u);
          // The edge sweeps inward until it lands on the shadow: the hole is
          // uncovered from the outside in, and the last frame is the real one.
          radius = frame.cover + (frame.shadow - frame.cover) * e;
          alpha = 1 - smoothstep01(clamp01((u - 0.86) / 0.14));
          streak = 0.25 + 0.9 * (1 - e);
          rim = 0.2 + 0.8 * Math.sin(Math.PI * u);
        }
        vfx.setPhase({ center: frame.center, radius, alpha, streak, rim });
        worm.phase = { radius, alpha, streak, rim };
        worm.alpha = alpha;
        vfx.update(0.016);
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

    const centerAt = (clientX, clientY) => {
      const region = centerRegion();
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      return { inside: Math.hypot(px - region.x, py - region.y) <= region.r, region };
    };

    const canOpenCenter = () => machine.mode === 'black-hole' && machine.progress < 0.05;

    /**
     * The hole's centre is the way into the genre field.
     *
     * It used to open a search box; the search is gone, and the centre now
     * enters the nebula — the thirteen-genre space — from which a genre opens
     * its own cluster. The host is told through `onCenterClick` so it can
     * mirror the same state in its own UI.
     */
    const centerClick = () => {
      if (!canOpenCenter()) return;
      clearTimers();
      if (typeof settings.onCenterClick === 'function') {
        try {
          settings.onCenterClick();
        } catch {
          /* ignore */
        }
      }
    };

    /**
     * Right click goes back one level: an open cluster returns to the hole, an
     * open genre leaves the nebula, and at the hole itself it does nothing.
     * Suppressing the context menu is what makes the right click a gesture
     * rather than a browser menu.
     */
    const onContextMenu = (event) => {
      event.preventDefault();
      if (document.body && document.body.getAttribute('data-bhrl-no-context') === 'true') return;
      // A cluster is not part of the wormhole: the right click still walks back
      // one level in a single step, exactly as it did before the transition.
      if (machine.mode === 'cluster' || machine.progress > 0.05) {
        if (machine.target > 0.5) exitCluster({});
        return;
      }
      // With the wormhole on, the right button is a hold and not a click, so the
      // menu is only suppressed here; the pointer handlers do the work. Touch has
      // no second button, so the browser's long press stays its way out.
      if (wormholeEnabled && lastPointerType !== 'touch') return;
      if (machine.nebula > 0.05 || machine.nebulaTarget > 0.5) {
        exitNebula({});
      }
    };

    const onPointerDown = (event) => {
      lastPointerType = event.pointerType || 'mouse';
      if (event.button === 2) {
        // Right is the way back out, and only by holding it. A short right click
        // does nothing at all: the exit used to be instant, and an instant exit
        // would be a shortcut around the wormhole.
        if (!wormholeEnabled) return;
        // While a hold owns the gesture, nothing else may start one. The only
        // thing a second right press does is land a running exit. A recoil is
        // not a hold — it is the last cancel fading out — so it does not block
        // the next press.
        if (worm.kind && worm.kind !== 'recoil') {
          if (skipWormhole()) event.preventDefault();
          return;
        }
        if (machine.mode === 'nebula' || machine.nebula > 0.05 || machine.nebulaTarget > 0.5) {
          event.preventDefault();
          startHold('exit', event);
        }
        return;
      }
      if (event.button !== 0) return;
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
      // press on the hole itself, which is not a button and does nothing.
      if (canOpenCenter() && (!worm.kind || worm.kind === 'recoil') && centerAt(event.clientX, event.clientY).inside) {
        if (wormholeEnabled) {
          // The hold draws its own ring, so the press is consumed now: the
          // release must not also select something.
          press.consumed = true;
          startHold('enter', event);
          return;
        }
        longTimer = setTimeout(() => {
          longTimer = 0;
          if (!press.active) return;
          press.consumed = true;
          centerClick();
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (event) => {
      // A hold is a hold only while the pointer stays put. Eight pixels of slop
      // covers the hand shaking on a trackpad; past that it is a drag and the
      // camera is what the gesture belongs to.
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
        }
        return;
      }
      const now = performance.now();
      if (now - lastHover < HOVER_INTERVAL_MS) return;
      lastHover = now;

      // The nebula space has its own hover: the hole's centre control and its
      // station picking are both absent there.
      if (machine.mode === 'nebula' && machine.nebula > 0.5) {
        const hit = pickNebulaAt(event.clientX, event.clientY);
        setNebulaHover(hit ? hit.index : -1);
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
      canvas.style.cursor =
        overRadio || hit.inside ? 'pointer' : pick(event.clientX, event.clientY) >= 0 ? 'pointer' : 'grab';
    };

    const onPointerUp = (event) => {
      if (event.button === 2) {
        // Letting go of the right button before the ring fills is a cancel:
        // nothing has moved yet, so there is nothing to take back. Only the very
        // button that opened the hold may end it.
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
      // Releasing before the ring fills is the cancel. This must come before the
      // consumed check: the press was consumed at pointer down precisely so the
      // release would not select anything, and the hold still has to end.
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId && event.button === worm.button) {
        cancelHold();
      }
      if (press.consumed) {
        press.consumed = false;
        return;
      }
      const moved = Math.hypot(event.clientX - press.downX, event.clientY - press.downY);
      const held = performance.now() - press.at;
      if (!isSelectionGesture(moved, held)) return;
      // A drag orbits the camera and never selects; the same rule the black hole
      // uses, applied to the volumes.
      if (machine.mode === 'nebula' && machine.nebula > 0.5) {
        const hit = pickNebulaAt(event.clientX, event.clientY);
        setGenre(hit ? hit.id : null);
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
        // Holding the centre is what enters the genre field; letting go of it
        // is not, so a press that ended before the timer fired leaves the hole
        // as it was instead of selecting or clearing anything.
        return;
      }
      const index = pick(event.clientX, event.clientY);
      if (index >= 0) {
        clearRadioSelection();
        select(index, { focus: true, notify: true });
      } else {
        clearSelection(true);
        clearRadioSelection();
      }
    };

    const onPointerCancel = (event) => {
      press.active = false;
      press.consumed = false;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId) cancelHold();
    };

    const onPointerLeave = (event) => {
      canvas.style.cursor = 'grab';
      if (worm.kind && !worm.locked && event.pointerId === worm.pointerId) cancelHold();
      if (machine.mode === 'nebula' && hoverNebulaIndex >= 0) setNebulaHover(-1);
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
    // Development preview entry (`?bhrlNebula=1`, or the harness): it changes
    // nothing about a normal mount, and it never touches the hole's click path.
    if (settings.nebulaPreview === true && nebula) enterNebula();

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
      nebula: nebula
        ? {
            volumes: nebulaLayout.genres.length,
            particles: nebula.particleCount,
            seed: nebulaLayout.seed,
            extent: Math.round(nebulaLayout.extent * 100) / 100,
          }
        : null,
    };

    const handle = {
      info,

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
      locateStation: focusOrSelect,

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

      /** Dev/phase-4 entry into the nebula space; no panel UI uses it yet. */
      enterNebula,
      exitNebula,
      setGenre,

      get genreId() {
        return machine.genreId;
      },

      /** Layout + live state, for verification. */
      nebula: {
        get visible() {
          return Boolean(nebula && nebula.object.visible);
        },
        get layout() {
          return nebulaLayout;
        },
        get hoverIndex() {
          return hoverNebulaIndex;
        },
        get selectedIndex() {
          return nebulaIndex();
        },
        get particleCount() {
          return nebula ? nebula.particleCount : 0;
        },
        labels: () => nebulaLabels(),
        pick: (clientX, clientY) => pickNebulaAt(clientX, clientY),
      },

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
        labelCategories = buildLabelCategories(categories, lang);
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
        return { scene, camera, rig, renderer, canvas, parts: { starfield, disk, layer, labels, nebula } };
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
          elapsed: worm.kind ? (performance.now() - worm.startedAt) / 1000 : 0,
          cover: machine.wormCover,
          nebulaSpeed,
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
        if (kind === 'exit' && !(machine.mode === 'nebula' || machine.nebula > 0.05)) return false;
        const rect = container.getBoundingClientRect();
        const hole = silhouette();
        startHold(kind, { clientX: rect.left + hole.x, clientY: rect.top + hole.y });
        return true;
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
        transitioning = false;
        machine.nebula = machine.nebulaTarget;
        nebulaMoving = false;
        if (layer) {
          for (let i = 0; i < stations.length; i += 1) layer.setClusterAmount(machine.target);
        }
        applyTransition();
        finishTransition();
        finishNebulaTransition();
        dirty = true;
        requestFrame();
      },
      enterNebula(options) {
        return enterNebula(options);
      },
      exitNebula(options) {
        return exitNebula(options);
      },
      setGenre(id) {
        return setGenre(id);
      },
      nebulaInfo() {
        if (!nebula) return null;
        return {
          seed: nebulaLayout.seed,
          signature: nebulaLayout.signature,
          extent: nebulaLayout.extent,
          camera: nebulaLayout.camera,
          maxShift: nebulaLayout.maxShift,
          volumes: nebulaLayout.genres.map((volume) => ({
            id: volume.id,
            index: volume.index,
            count: volume.count,
            radius: volume.radius,
            center: { ...volume.center },
            color: volume.color.slice(),
            brightness: volume.brightness,
          })),
          perNebula: nebula.perNebula.slice(),
          starsPerNebula: nebula.starsPerNebula.slice(),
          particleCount: nebula.particleCount,
          amount: nebula.amount,
          hoverIndex: hoverNebulaIndex,
          selectedIndex: nebulaIndex(),
          genreId: machine.genreId,
        };
      },
      nebulaLabels() {
        return nebulaLabels();
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
      nebulaPick(x, y) {
        return pickNebulaAt(x, y);
      },
      nebulaHover(index) {
        setNebulaHover(index);
        if (nebula) nebula.update(1 / 60, { instant: true });
        return hoverNebulaIndex;
      },
      nebulaParticleAt(index) {
        if (!nebula) return null;
        const points = nebula.object.geometry.attributes;
        if (!points || index < 0 || index >= nebula.particleCount) return null;
        return {
          position: [
            points.position.getX(index),
            points.position.getY(index),
            points.position.getZ(index),
          ],
          tint: [points.aTint.getX(index), points.aTint.getY(index), points.aTint.getZ(index)],
          size: points.aSize.getX(index),
          alpha: points.aAlpha.getX(index),
          nebula: points.aNebula.getX(index),
          star: points.aStar.getX(index),
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
 * the stage simply has no nebula space to enter.
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

function buildLabelCategories(categories, language) {
  return (categories || []).map((category) => ({
    id: category.id,
    count: category.count || 0,
    label: categoryLabel(category.id, language),
    position: category.position || { x: 0, y: 0, z: 0 },
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

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
