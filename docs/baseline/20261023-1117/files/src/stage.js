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
 * Everything between is one continuous state value (`progress`, eased) plus the
 * station layer's per-station blend. Nothing is ever rebuilt: the same scene,
 * the same renderer, the same camera rig, the same Points buffer. That is what
 * makes the transition reversible at any instant — enter and exit animate the
 * same numbers in opposite directions, so an interrupted transition keeps
 * moving from where it is instead of snapping.
 *
 * The interaction machine (single source of truth for the panel):
 *
 *   black-hole ──click centre──▶ search ──Esc/close──▶ black-hole
 *   black-hole ──hover 600ms──▶ category-panel ──leave──▶ black-hole
 *   black-hole ──pick category──▶ transition-to-cluster ──▶ cluster
 *   cluster ──Esc/back──▶ transition-to-black-hole ──▶ black-hole
 *
 * Picking, hovering, long-press and the keyboard all funnel into this machine;
 * the panel never writes scene state directly.
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
import {
  HORIZON_RADIUS,
  CRITICAL_IMPACT_PARAMETER,
  shadowAngularRadius,
} from './scene/dimensions.js';
import { categoryLabel } from './radio/taxonomy.js';
import { createStationsLayer } from './nodes/stations-layer.js';
import { createLabelOverlay } from './nodes/label-overlay.js';
import { buildClusterLayout, projectedDiameter } from './cluster/layout.js';

/** Surface this module's phase honestly, in one place. */
export const STAGE_PHASE = 'phase-5';

/** Drags longer than this (CSS px) are camera gestures, never selections. */
const CLICK_SLOP = 6;
/** Hover picking is throttled: a pointer moving across 2,000 dots must not
 * run 2,000 projections per pointer event. */
const HOVER_INTERVAL_MS = 90;
/** Resting on the hole this long reveals the category panel. */
const HOVER_OPEN_MS = 600;
/** Touch has no hover: holding the centre this long opens the same panel. */
const LONG_PRESS_MS = 560;
/** A press held longer than this is not a click, whatever else it did. */
const PRESS_CLICK_MS = 800;
/** Progress units per second; the full transition takes ~1.05 s. */
const TRANSITION_RATE = 0.95;
/** Catalogue brightness while the hole is the subject. */
const HOLE_STATION_DIM = 0.55;

/** The black-hole camera framing, restored on exit. */
const HOLE_LIMITS = { minRadius: 6.0, maxRadius: 44 };

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
 * @param options.onCenterClick - the hole centre was clicked (open search).
 * @param options.onHoverChange - (active) for the 600 ms category hover.
 * @returns a handle with selection, mode, camera and measurement helpers.
 */
export function mountStage(container, options) {
  const settings = options || {};
  const antialias = settings.antialias !== false;
  const pixelRatioCap = clampRatio(settings.pixelRatioCap);
  const reducedMotion = settings.reducedMotion === true;
  const language = settings.language === 'en' ? 'en' : 'zh';

  const catalog = resolveCatalog(settings);
  const stations = catalog.stations;
  const categories = catalog.categories;
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

    const labels = createLabelOverlay(container);
    disposers.push(() => labels.dispose());

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
    };
    const layoutCache = new Map();
    let lastModeKey = '';
    let transitioning = false;

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
      disk.setViewport(buffer.x, buffer.y);
      starfield.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
      if (layer) {
        layer.setPixelRatio(renderer.getPixelRatio());
        layer.setViewport(w, h, camera.fov);
      }
      labels.resize(w, h, renderer.getPixelRatio());
      return true;
    };

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

    /** Applied to every scene part from the one transition value. */
    const applyTransition = () => {
      const rise = smoothstep01(machine.progress);
      // The hole leaves a little after the stations start moving, and returns a
      // little before they arrive: the matter should look reorganised, not
      // cross-faded.
      const holeFade = smoothstep01(clamp01((rise - 0.05) / 0.72));
      disk.setOpacity(1 - holeFade);
      // Kept so this call site need not know that the analytic ring is gone:
      // the imaging pass draws the ring where the winding piles up, itself.
      disk.setRingIntensity(0.62 * (1 - holeFade));
      starfield.setDim(rise);
      if (layer) layer.setClusterAmount(rise);
      if (rise > 0.001) dirty = true;
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
    const collectGpuTimings = () => {
      if (!timerExt) return;
      if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)) {
        // A disjoint event means the clock changed underneath the queries; every
        // value still in flight is unusable.
        gpuDisjoint += 1;
        while (gpuQueries.length) gl.deleteQuery(gpuQueries.shift());
        return;
      }
      while (gpuQueries.length) {
        const query = gpuQueries[0];
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
        if (!gl.getQueryParameter(query, gl.QUERY_RESULT_DISJOINT)) {
          gpuSamples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
          if (gpuSamples.length > 120) gpuSamples.shift();
        }
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
      if (layer) {
        const info = layer.filterInfo();
        // The label overlay follows the same rule: black-hole mode draws none.
        // It is still created, resized and disposed exactly as before.
        const labelReveal = machine.progress;
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

      if (dirty) draw();
      const morphing = layer ? layer.isAnimating : false;
      if (!reducedMotion || moved || morphing || transitioning) frame = requestAnimationFrame(tick);
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

    const syncDataset = () => {
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

    const notifyHover = (active) => {
      if (typeof settings.onHoverChange !== 'function') return;
      try {
        settings.onHoverChange(Boolean(active));
      } catch {
        /* ignore */
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
        transitioning,
        stations: stations.length,
      };
    };

    const setUi = (ui) => {
      const next = ui === 'search' || ui === 'category-panel' ? ui : 'black-hole';
      if (machine.ui === next) return;
      const previous = machine.ui;
      machine.ui = next;
      if (next === 'search') {
        hoverSuspended = true;
      } else if (previous === 'search') {
        hoverSuspended = true;
        clearTimers();
      }
      notifyMode();
    };

    /** Stop every pending hover/long-press timer. Called on mode changes. */
    const clearTimers = () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      hoverNotified = false;
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
      rig.setHome({
        radius: saved && saved.radius ? saved.radius : undefined,
        phi: saved && saved.phi ? saved.phi : undefined,
        theta: saved && Number.isFinite(saved && saved.theta) ? saved.theta : undefined,
        minRadius: HOLE_LIMITS.minRadius,
        maxRadius: HOLE_LIMITS.maxRadius,
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

    // ---- pointer / hover / long-press -------------------------------------

    const press = { active: false, id: -1, x: 0, y: 0, downX: 0, downY: 0, at: 0, consumed: false, moved: false };
    let lastHover = 0;
    let hoverTimer = 0;
    let longTimer = 0;
    let hoverNotified = false;
    // After search closes, the pointer is still parked on the centre. Hover must
    // wait until it actually leaves the hole, otherwise closing a search would
    // instantly summon the category panel under the same cursor.
    let hoverSuspended = false;

    const centerAt = (clientX, clientY) => {
      const region = centerRegion();
      const rect = canvas.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      return { inside: Math.hypot(px - region.x, py - region.y) <= region.r, region };
    };

    const canOpenCenter = () => machine.mode === 'black-hole' && machine.progress < 0.05 && machine.ui !== 'search';

    const centerClick = () => {
      if (!canOpenCenter()) return;
      clearTimers();
      machine.ui = 'search';
      notifyMode();
      if (typeof settings.onCenterClick === 'function') {
        try {
          settings.onCenterClick();
        } catch {
          /* ignore */
        }
      }
    };

    const showCategories = () => {
      if (!canOpenCenter()) return;
      if (machine.ui === 'category-panel') return;
      machine.ui = 'category-panel';
      notifyMode();
      if (typeof settings.onHoverChange === 'function') {
        try {
          settings.onHoverChange(true);
        } catch {
          /* ignore */
        }
      }
    };

    const releaseHover = () => {
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
      if (!hoverNotified && machine.ui !== 'category-panel') return;
      hoverNotified = false;
      if (machine.ui === 'category-panel') {
        machine.ui = 'black-hole';
        notifyMode();
      }
      notifyHover(false);
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      press.active = true;
      press.id = event.pointerId;
      press.x = event.clientX;
      press.y = event.clientY;
      press.downX = event.clientX;
      press.downY = event.clientY;
      press.at = performance.now();
      press.consumed = false;
      press.moved = false;
      // A press ends any pending dwell: no panel may open mid-click or mid-drag.
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
      if (event.pointerType === 'touch' && canOpenCenter() && centerAt(event.clientX, event.clientY).inside) {
        // Long press is the touch equivalent of the 600 ms hover.
        longTimer = setTimeout(() => {
          longTimer = 0;
          if (!press.active) return;
          press.consumed = true;
          hoverNotified = true;
          showCategories();
        }, LONG_PRESS_MS);
      }
    };

    const onPointerMove = (event) => {
      if (press.active && press.id === event.pointerId) {
        if (Math.hypot(event.clientX - press.downX, event.clientY - press.downY) > CLICK_SLOP) {
          press.moved = true;
          if (longTimer) {
            clearTimeout(longTimer);
            longTimer = 0;
          }
          // A camera drag retracts the category panel; a hover must not linger
          // over a view the user is actively moving.
          if (hoverNotified) releaseHover();
        }
        return;
      }
      const now = performance.now();
      if (now - lastHover < HOVER_INTERVAL_MS) return;
      lastHover = now;

      if (!canOpenCenter()) {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = 0;
        }
        if (hoverNotified) releaseHover();
        canvas.style.cursor = 'grab';
        return;
      }

      const hit = centerAt(event.clientX, event.clientY);
      canvas.style.cursor = hit.inside ? 'pointer' : pick(event.clientX, event.clientY) >= 0 ? 'pointer' : 'grab';
      if (!hit.inside) hoverSuspended = false;
      if (hit.inside) {
        if (!hoverTimer && !hoverNotified && machine.ui === 'black-hole' && !hoverSuspended) {
          hoverTimer = setTimeout(() => {
            hoverTimer = 0;
            if (!canOpenCenter()) return;
            hoverNotified = true;
            showCategories();
          }, HOVER_OPEN_MS);
        }
      } else if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      } else if (hoverNotified) {
        releaseHover();
      }
    };

    const onPointerUp = (event) => {
      if (!press.active || press.id !== event.pointerId) return;
      press.active = false;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
      if (press.consumed) {
        press.consumed = false;
        return;
      }
      const moved = Math.hypot(event.clientX - press.downX, event.clientY - press.downY);
      const held = performance.now() - press.at;
      if (moved > CLICK_SLOP || held > PRESS_CLICK_MS) return;
      if (centerAt(event.clientX, event.clientY).inside) {
        // The centre always means search, even while the category panel is up:
        // a hover must never turn a click into a category choice.
        centerClick();
        return;
      }
      const index = pick(event.clientX, event.clientY);
      if (index >= 0) select(index, { focus: true, notify: true });
      else clearSelection(true);
    };

    const onPointerCancel = () => {
      press.active = false;
      press.consumed = false;
      if (longTimer) {
        clearTimeout(longTimer);
        longTimer = 0;
      }
    };

    const onPointerLeave = () => {
      canvas.style.cursor = 'grab';
      if (press.active) return;
      if (hoverTimer) {
        clearTimeout(hoverTimer);
        hoverTimer = 0;
      }
      // Leaving the canvas for the category panel is not a dismiss: the panel
      // lives above the canvas, so it decides when the pointer really left via
      // its own document-level tracker. Only a panel that was never entered
      // (state already back to black-hole) is cleaned up here.
      if (hoverNotified && machine.ui !== 'category-panel') releaseHover();
    };

    const onKeyDown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        if (!canOpenCenter()) return;
        event.preventDefault();
        centerClick();
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('keydown', onKeyDown);
    disposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('keydown', onKeyDown);
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
      } else {
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
       * hover and centre clicks would disagree with what is on screen.
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

      dispose() {
        if (disposed) return;
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        clearTimers();
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

    // Read-only verification surface, version 5: the phase-4 checks drive the
    // machine through the same entry points the panel uses.
    const debug = {
      version: 5,
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
        if (layer) {
          for (let i = 0; i < stations.length; i += 1) layer.setClusterAmount(machine.target);
        }
        applyTransition();
        finishTransition();
        dirty = true;
        requestFrame();
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

function resolveCatalog(settings) {
  const stations = Array.isArray(settings.stations) ? settings.stations : [];
  const categories =
    Array.isArray(settings.categories) && settings.categories.length > 0
      ? settings.categories
      : summarizeStations(stations);
  return { stations, categories, seed: Number(settings.seed) || 0 };
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
