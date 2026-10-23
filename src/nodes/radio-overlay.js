/**
 * The fixture label layer.
 *
 * Only the four phase-2 radio fixtures ever reach this canvas, and only when the
 * test switch is on. An anchor is not a projected 3-D point: the stage finds it
 * by asking the imaging shader which pixel shows that fixture's id, so the label
 * sits on the image the trace actually produced — including the bent one, which
 * a plain projection would put on the wrong side of the hole.
 *
 * Nothing here is interactive. Picking goes through the id channel in the stage,
 * so the text and the hit target can never disagree.
 */

const COLOR_TEXT = 'rgba(236, 232, 226, 0.92)';
const COLOR_TEXT_DIM = 'rgba(214, 208, 200, 0.62)';
const COLOR_RING = 'rgba(255, 236, 200, 0.95)';
const COLOR_SHADOW = 'rgba(2, 3, 8, 0.92)';
const FONT_LABEL = '600 11px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_BRANCH = '500 9px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';

export function createRadioOverlay(container) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-bhrl-radio-labels', 'true');
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  // Above the station labels (z-index 2): a fixture name is the test subject.
  canvas.style.zIndex = '3';
  canvas.style.display = 'block';
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let width = 1;
  let height = 1;
  let ratio = 1;
  let disposed = false;

  function resize(w, h, pixelRatio) {
    width = Math.max(1, Math.round(w));
    height = Math.max(1, Math.round(h));
    ratio = Math.max(1, Number(pixelRatio) || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    if (ctx) ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function clear() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
  }

  function textLabel(text, x, y, font, color) {
    ctx.font = font;
    ctx.fillStyle = COLOR_SHADOW;
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /**
   * @param {{anchors: Array<{businessId:string,gpuId:number,branch:number,x:number,y:number,label:string}>,
   *   selectedBusinessId: (string|null), selectedBranch: number}} frame
   */
  function draw(frame) {
    if (!ctx || disposed) return;
    ctx.clearRect(0, 0, width, height);
    const anchors = (frame && frame.anchors) || [];
    if (anchors.length === 0) return;

    const selected = frame.selectedBusinessId || null;
    const selectedBranch = Number(frame.selectedBranch) || 0;

    // Painter order: dim anchors first, so the selected one is never covered.
    const ordered = anchors
      .slice()
      .sort((a, b) => Number(a.businessId === selected) - Number(b.businessId === selected));

    for (const anchor of ordered) {
      const isSelected = anchor.businessId === selected;
      const isPickedBranch = isSelected && (selectedBranch === 0 || selectedBranch === anchor.branch);
      const x = Math.round(anchor.x);
      const y = Math.round(anchor.y);

      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = isPickedBranch ? COLOR_RING : 'rgba(214, 208, 200, 0.42)';
      if (isPickedBranch) {
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - 20, y);
        ctx.lineTo(x - 16, y);
        ctx.moveTo(x + 16, y);
        ctx.lineTo(x + 20, y);
        ctx.moveTo(x, y - 20);
        ctx.lineTo(x, y - 16);
        ctx.moveTo(x, y + 16);
        ctx.lineTo(x, y + 20);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      const labelX = x + 18;
      const labelY = y - 8;
      textLabel(anchor.label, labelX, labelY, FONT_LABEL, isSelected ? COLOR_RING : COLOR_TEXT);
      textLabel(`branch ${anchor.branch}`, labelX, labelY + 12, FONT_BRANCH, COLOR_TEXT_DIM);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return { canvas, resize, draw, clear, dispose };
}

export default createRadioOverlay;
