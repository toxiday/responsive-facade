// Orthographic camera orbiting a fixed room (guidelines §3.1): the room never rotates, the
// camera does. The polar angle is clamped so the view stays above the ground.

import { OrthographicCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Room } from '../data/manifest';
import { roomToThree } from './frame';

export const POLAR_MIN = 0.05;
export const POLAR_MAX = 1.3;

export type ViewName = 'axo' | 'top' | 'ne' | 'se' | 'sw' | 'nw';

/** Horizontal direction (room frame) the camera sits in, for each named corner view. */
const CORNERS: Record<Exclude<ViewName, 'top'>, [number, number]> = {
  axo: [1, 1],
  ne: [1, 1],
  se: [1, -1],
  sw: [-1, -1],
  nw: [-1, 1],
};

export interface ViewRig {
  camera: OrthographicCamera;
  controls: OrbitControls;
  target: Vector3;
  resize(width: number, height: number): void;
  setView(name: ViewName): void;
}

export function createViewRig(room: Room, dom: HTMLElement): ViewRig {
  const target = roomToThree(room.width / 2, room.depth / 2, 0.9);
  const span = Math.hypot(room.width, room.depth) * 1.12;
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const controls = new OrbitControls(camera, dom);
  controls.target.copy(target);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minPolarAngle = POLAR_MIN;
  controls.maxPolarAngle = POLAR_MAX;
  controls.minZoom = 0.6;
  controls.maxZoom = 4;
  controls.zoomToCursor = false;

  let aspect = 1;
  const resize = (width: number, height: number) => {
    aspect = width / Math.max(1, height);
    // Fit the room diagonal in the shorter screen direction.
    const half = aspect >= 1 ? span / 2 : span / 2 / aspect;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  };

  const setView = (name: ViewName) => {
    // Default (axo): from the NE, looking at the S and W facades from inside.
    const polar = 1.0;
    // Top view: a hair south of vertical, so OrbitControls' up vector resolves to north-up.
    const dir =
      name === 'top'
        ? new Vector3(0, 1, 1e-4)
        : roomToThree(...CORNERS[name], 0)
            .normalize()
            .multiplyScalar(Math.sin(polar))
            .setY(Math.cos(polar));
    camera.position.copy(target).addScaledVector(dir.normalize(), 40);
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    controls.update();
  };

  setView('axo');
  return { camera, controls, target, resize, setView };
}
