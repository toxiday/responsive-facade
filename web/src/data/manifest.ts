// Types and loader for web/public/data/manifest.json (written by `python -m bake manifest`).

export type Side = 'S' | 'N' | 'E' | 'W';
export type Vec3 = [number, number, number];

/** An opening in a closed wall, from the floor 5 plan. a0..a1 runs along the wall (x on S/N,
 * y on E/W), from the floor up to z1. */
export interface Opening {
  id: string;
  wall: Side;
  kind: 'door' | 'opening';
  a0: number;
  a1: number;
  z1: number;
  /** Along-wall position of the door's hinge (it swings into the room). */
  hinge: number | null;
  label: string;
}

export interface Room {
  id: string;
  width: number;
  depth: number;
  height: number;
  north_angle: number;
  sides: Side[];
  open: boolean[];
  wall_azimuth_deg: Record<Side, number>;
  sensor_height: number;
  openings: Opening[];
}

/** Where a person sits or stands to use a piece, which way they face, and what they do. */
export interface Seat {
  x: number;
  y: number;
  /** Degrees counter-clockwise from room +x. */
  facing: number;
  activity: string;
}

export interface FurnitureItem {
  id: string;
  type: string;
  label: string;
  bbox: [number, number, number, number];
  z0: number;
  z1: number;
  facing: number | null;
  click: string | null;
  added: boolean;
  /** Shape parameters for the builder (bake/room.py), e.g. the sofa's chaise. */
  params: Record<string, unknown> | null;
  /** Where people use it (the sofa has two: main seat and chaise). */
  seats: Seat[];
  /** The wall it hangs on; the cutaway hides it with that wall. */
  wall: Side | null;
  obstacle: boolean;
  /** Floor rects [x0, y0, x1, y1]: the bbox, or the parts of an L-shaped piece. */
  footprint: [number, number, number, number][];
}

export interface Zone {
  x: number;
  y: number;
  target: number;
  radius: number;
  role: 'activity' | 'screen_proxy' | 'ambient' | 'standing';
}

export interface OccupantState {
  id: string;
  label: string;
  /** 'standing' states cover the open floor on a lattice, one zone each. */
  kind: 'ambient' | 'activity' | 'standing';
  zones: Zone[];
  /** 32x32 zone owner grid, row-major (row 0 = N edge): '.' = unowned, '0'..'9' = zone index. */
  owner: string;
  occupied_cells: number;
}

export interface Activity {
  id: string;
  label: string;
  states: string[];
  spot: [number, number];
  facing: number;
  pose: string;
}

export interface Legend {
  vmin: number;
  vmax: number;
  usable: [number, number];
  glare: number;
  lut: [number, number, number][];
}

export interface CityMonth {
  month: number;
  day: number;
  ghi_wh: number;
  ghi_median_wh: number;
  n_slots: number;
}

export interface City {
  id: string;
  label: string;
  wea: string;
  lat: number;
  lon: number;
  tz: number;
  months: CityMonth[];
}

export interface Manifest {
  schema: number;
  room: Room;
  furniture: FurnitureItem[];
  activities: Activity[];
  states: OccupantState[];
  legend: Legend;
  sky_labels: [string, number][];
  cities: City[];
}

export const SCHEMA = 1;

/** Decode an owner string to zone indices (-1 = unowned). */
export function ownerGrid(owner: string): Int8Array {
  const out = new Int8Array(owner.length);
  for (let i = 0; i < owner.length; i++) out[i] = owner[i] === '.' ? -1 : owner.charCodeAt(i) - 48;
  return out;
}

export function checkManifest(m: Manifest): Manifest {
  const problems: string[] = [];
  if (m.schema !== SCHEMA) problems.push(`schema ${m.schema} (expected ${SCHEMA})`);
  const r = m.room;
  if (!(r?.width > 0 && r.depth > 0 && r.height > 0)) problems.push('room dimensions');
  if (r?.sides?.join('') !== 'SNEW') problems.push('wall order');
  if (m.legend?.lut?.length !== 256) problems.push('legend lut');
  for (const s of m.states ?? []) {
    if (s.owner.length !== 1024) problems.push(`state ${s.id} owner grid`);
  }
  if (problems.length) throw new Error(`manifest.json is invalid: ${problems.join(', ')}`);
  return m;
}

export async function loadManifest(base: string = import.meta.env.BASE_URL): Promise<Manifest> {
  const res = await fetch(`${base}data/manifest.json`);
  if (!res.ok) throw new Error(`manifest.json: HTTP ${res.status}`);
  return checkManifest((await res.json()) as Manifest);
}
