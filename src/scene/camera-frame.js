import { Vector2 } from 'three';

/** Scratch storage, refreshed on every call and consumed by adjacent passes. */
export function createCameraFrame(renderer) {
  const viewport = new Vector2();
  const frame = { elements: null, tanHalfFov: 0, viewport };
  return (camera) => {
    camera.updateMatrixWorld();
    frame.elements = camera.matrixWorld.elements;
    frame.tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
    renderer.getDrawingBufferSize(viewport);
    return frame;
  };
}
