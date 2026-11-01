// Shared palette: a light architectural-model look. One place to retune colours.

import { Color, MeshStandardMaterial } from 'three';

export const PALETTE = {
  background: new Color('#f3f1ed'),
  floor: new Color('#d8d2c8'),
  poche: new Color('#6b655d'),
  wall: new Color('#efede9'),
  ceiling: new Color('#efede9'),
  panel: new Color('#e9e6e1'),
  glass: new Color('#9cc3dc'),
  mullion: new Color('#8f8a84'),
  furniture: new Color('#cfc9c0'),
  fabric: new Color('#b9b2a8'),
  rug: new Color('#e9e3d8'),
  wood: new Color('#c4ad8e'),
  dark: new Color('#3b3a39'),
  steel: new Color('#b7b9ba'),
  added: new Color('#b9cfc6'),
  accent: new Color('#ec008c'),
};

export function solid(color: Color, roughness = 0.9): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness: 0 });
}
