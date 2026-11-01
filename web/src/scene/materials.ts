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
  // Furniture colour scheme (Tony, 2026-11-01). Specified in CMYK; converted to sRGB through
  // U.S. Web Coated (SWOP) v2, relative colorimetric with black point compensation. Then, at
  // Tony's ask, Sulphur Yellow darkened to Cinnamon's lightness (L* 77) and Cinnamon's chroma cut
  // by a quarter, both in CIELAB so the hues hold. SWOP equivalents in brackets.
  olive: new Color('#837e31'), // C48 M38 Y100 K15: sofa, armchairs
  cinnamon: new Color('#e4b790'), // Pinkish Cinnamon (~C9 M30 Y45 K0): tables, chairs, stools
  slate: new Color('#253122'), // Deep Slate Olive C76 M60 Y80 K62: TV, range, fridge
  sulphur: new Color('#c8c097'), // Sulphur Yellow (~C22 M20 Y46 K0): counter tops, dining
  //                                table, rug, media console
  dark: new Color('#3b3a39'),
  steel: new Color('#b7b9ba'),
  added: new Color('#b9cfc6'),
  accent: new Color('#ec008c'), // presentation magenta: window outlines, debug overlays
};

export function solid(color: Color, roughness = 0.9): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness: 0 });
}
