/**
 * The text layer above the WebGL canvas.
 *
 * Labels live in one 2-D canvas for the same reason the nodes live in one draw
 * call: thousands of absolutely positioned DOM nodes would cost layout and
 * paint on every camera frame, and the browser would keep them alive even when
 * nothing is visible. A canvas gives exact control over how many labels exist
 * per frame (here: at most eighteen), over fading, and over collisions, while
 * costing one element per stage.
 *
 * What is drawn:
 *   - the selected station, always, with a hairline to its place in the disk;
 *   - featured and nearby station names, only when the camera is close enough
 *     for a name to mean something;
 *   - the name of a revealed category cloud while a category filter is active,
 *     placed at the cloud's live centroid.
 *
 * Categories have no place names in the default view on purpose: the default
 * view is one continuous accretion structure, and a category legend pinned on
 * top of it would re-introduce exactly the partition the rework removed.
 *
 * Nothing here is interactive. Picking happens in the stage against the same
 * projection, so the text and the hit target never disagree.
 */

import { Vector3 } from 'three';

const MAX_STATION_LABELS = 14;
const MAX_CLOUD_LABELS = 6;

const COLOR_TEXT = 'rgba(234, 226, 216, 0.88)';
const COLOR_TEXT_DIM = 'rgba(214, 203, 190, 0.58)';
const COLOR_ACCENT = 'rgba(244, 178, 133, 0.96)';
const COLOR_SHADOW = 'rgba(2, 3, 8, 0.9)';
const FONT_STATION = '500 11px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SELECTED = '600 12px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_CLOUD = '600 10px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';

export function createLabelOverlay(container) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-bhrl-labels', 'true');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '2';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  const projected = new Vector3();
  const boxes = [];
  let width = 1;
  let height = 1;
  let ratio = 1;
  let disposed = false;
  /** Screen-space shadow disc for the current frame; labels avoid it. */
  let hole = null;

  function resize(w, h, pixelRatio) {
    width = Math.max(1, Math.round(w));
    height = Math.max(1, Math.round(h));
    ratio = Math.max(1, Number(pixelRatio) || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function project(position, camera) {
    projected.set(position.x, position.y, position.z).project(camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return {
      x: (projected.x * 0.5 + 0.5) * width,
      y: (0.5 - projected.y * 0.5) * height,
    };
  }

  function overlaps(x, y, w, h) {
    for (const box of boxes) {
      if (
        x < box.x + box.w + 6 &&
        x + w + 6 > box.x &&
        y < box.y + box.h + 4 &&
        y + h + 4 > box.y
      ) {
        return true;
      }
    }
    return false;
  }

  function drawLabel(text, x, y, options) {
    if (!ctx) return false;
    const opts = options || {};
    ctx.font = opts.font || FONT_STATION;
    const w = ctx.measureText(text).width;
    if (opts.align === 'center') x -= w / 2;
    if (x + w > width - 8 || x < -w || y < 10 || y > height - 6) return false;
    const padX = opts.padX === undefined ? 4 : opts.padX;
    const boxX = x - padX;
    // Nothing is allowed to sit on the shadow silhouette: a label over the hole
    // steals the one area the scene is built around. The selected station's own
    // name is exempt, because the reader asked for exactly that node.
    if (!opts.force && hole) {
      // Box-to-disc distance, not centre-to-centre: a wide label whose centre
      // clears the shadow can still hang half of itself over the black circle.
      const nearestX = Math.max(boxX, Math.min(hole.x, boxX + w + padX * 2));
      const nearestY = Math.max(y - 9, Math.min(hole.y, y + 5));
      if (Math.hypot(nearestX - hole.x, nearestY - hole.y) < hole.r + 8) return false;
    }
    if (!opts.force && overlaps(boxX, y - 9, w + padX * 2, 14)) return false;
    boxes.push({ x: boxX, y: y - 9, w: w + padX * 2, h: 14 });

    ctx.globalAlpha = opts.alpha === undefined ? 1 : opts.alpha;
    ctx.fillStyle = COLOR_SHADOW;
    ctx.fillText(text, x + 0.6, y + 0.8);
    ctx.fillStyle = opts.color || COLOR_TEXT;
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
    return true;
  }

  /**
   * Redraw the overlay for the current camera.
   * @param frame - { camera, lod, stations, selectedIndex, hole,
   *   visibilityAt(index), positionAt(index), clouds, cloudStrength }
   */
  function draw(frame) {
    if (!ctx || disposed) return;
    boxes.length = 0;
    ctx.clearRect(0, 0, width, height);
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = COLOR_SHADOW;
    ctx.shadowBlur = 3;

    const camera = frame.camera;
    hole = frame.hole || null;
    const lod = Math.min(1, Math.max(0, frame.lod || 0));
    const stations = frame.stations || [];
    const selectedIndex = typeof frame.selectedIndex === 'number' ? frame.selectedIndex : -1;
    const visibilityAt = typeof frame.visibilityAt === 'function' ? frame.visibilityAt : () => 1;
    // Live animated positions: during a cloud morph a label must travel with its
    // node instead of pointing at the authored slot it left behind.
    const positionAt =
      typeof frame.positionAt === 'function'
        ? frame.positionAt
        : (index) => (stations[index] ? stations[index].position : null);
    const cameraPos = camera.position;

    // 1. the selected station always gets a name, plus a hairline to its node
    if (selectedIndex >= 0 && stations[selectedIndex]) {
      const station = stations[selectedIndex];
      const p = project(positionAt(selectedIndex) || station.position, camera);
      if (p) {
        // A ring in screen space: the node itself sits inside the additive disk
        // glow, where a bright dot would be swallowed. A dark-backed ring is the
        // one cue that survives every brightness behind it.
        ctx.beginPath();
        ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(4, 6, 12, 0.72)';
        ctx.lineWidth = 3.2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 17, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 199, 148, 0.96)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        // Four small ticks make the ring read as a reticle rather than an orbit.
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 210, 170, 0.8)';
        ctx.lineWidth = 1.2;
        ctx.moveTo(p.x - 22, p.y);
        ctx.lineTo(p.x - 19, p.y);
        ctx.moveTo(p.x + 19, p.y);
        ctx.lineTo(p.x + 22, p.y);
        ctx.moveTo(p.x, p.y - 22);
        ctx.lineTo(p.x, p.y - 19);
        ctx.moveTo(p.x, p.y + 19);
        ctx.lineTo(p.x, p.y + 22);
        ctx.stroke();
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(244, 178, 133, 0.42)';
        ctx.lineWidth = 1;
        ctx.moveTo(p.x + 9, p.y - 9);
        ctx.lineTo(p.x + 2, p.y - 2);
        ctx.stroke();
        drawLabel(station.name, p.x + 12, p.y - 10, {
          font: FONT_SELECTED,
          color: COLOR_ACCENT,
          padX: 5,
          force: true,
        });
      }
    }

    // 2. featured and nearby station names, genuinely close only. On the default
    // overview the camera sits ~10.9 R out, so featured nodes (r 1.2) are ~9.6
    // away and stay unnamed: names are earned by proximity, not by being pretty.
    if (lod < 0.58) {
      const candidates = [];
      for (let i = 0; i < stations.length && candidates.length < 60; i += 1) {
        if (i === selectedIndex) continue;
        const station = stations[i];
        if (!station || !station.isFeatured) continue;
        const position = positionAt(i);
        if (!position) continue;
        const distance = cameraPos.distanceTo(position);
        if (distance > 6.4) continue;
        if (visibilityAt(i) < 0.6) continue;
        candidates.push({ i, distance });
      }
      // Nearby stations earn a name by proximity, not by the global LOD alone:
      // this is what makes the close range read as individual stations.
      for (let i = 0; i < stations.length; i += 1) {
        if (candidates.length >= MAX_STATION_LABELS + 8) break;
        if (i === selectedIndex) continue;
        const station = stations[i];
        if (!station || station.isFeatured) continue;
        const position = positionAt(i);
        if (!position) continue;
        const distance = cameraPos.distanceTo(position);
        if (distance > 3.6) continue;
        if (visibilityAt(i) < 0.6) continue;
        candidates.push({ i, distance });
      }
      candidates.sort((a, b) => a.distance - b.distance);
      let drawn = 0;
      for (const candidate of candidates) {
        if (drawn >= MAX_STATION_LABELS) break;
        const station = stations[candidate.i];
        const p = project(positionAt(candidate.i) || station.position, camera);
        if (!p) continue;
        const fade = Math.min(1, Math.max(0.25, 1 - candidate.distance / 12));
        if (drawLabel(station.name, p.x + 8, p.y - 7, { alpha: fade * 0.82 })) drawn += 1;
      }
    }

    // 3. revealed clouds name themselves, and only then. The default view has no
    // category place names at all, so nothing on screen suggests a partition
    // that is not there; a gathering cloud earns a name as it condenses.
    const clouds = Array.isArray(frame.clouds) ? frame.clouds : [];
    const cloudStrength = typeof frame.cloudStrength === 'number' ? frame.cloudStrength : 0;
    const cloudAlpha = Math.min(0.95, cloudStrength * 0.95) * (1 - 0.25 * lod);
    let drawnClouds = 0;
    if (cloudAlpha > 0.02) {
      for (const cloud of clouds) {
        if (drawnClouds >= MAX_CLOUD_LABELS) break;
        if (!cloud || !cloud.position) continue;
        const p = project(cloud.position, camera);
        if (!p) continue;
        if (p.x < 30 || p.x > width - 30 || p.y < 22 || p.y > height - 12) continue;
        const text = cloud.count ? `${cloud.label}  ${cloud.count}` : cloud.label;
        if (
          drawLabel(text, p.x, p.y - 26, {
            font: FONT_CLOUD,
            color: COLOR_ACCENT,
            alpha: cloudAlpha,
            padX: 3,
            align: 'center',
          })
        ) {
          drawnClouds += 1;
        }
      }
    }
    ctx.shadowBlur = 0;
  }

  return {
    canvas,
    resize,
    draw,
    /** Erase the overlay without tearing it down, for modes that draw no labels. */
    clear() {
      if (!ctx || disposed) return;
      boxes.length = 0;
      ctx.clearRect(0, 0, width, height);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    },
  };
}

/** Render one line of text width without drawing, for tests and tuning. */
export function measureLabelWidth(text, font) {
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return 0;
  probe.font = font || FONT_STATION;
  return probe.measureText(text).width;
}
