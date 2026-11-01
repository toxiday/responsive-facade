// Types and loader for web/public/data/manifest.json (written by `python -m bake manifest`).

export type Side = 'S' | 'N' | 'E' | 'W';
export type Vec3 = [number, number, number];

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
  obstacle: boolean;
}

export interface Zone {
  x: number;
  y: number;
  target: number;
  radius: number;
  role: 'activity' | 'screen_proxy' | 'ambient';
}

export interface OccupantState {
  id: string;
  label: string;
  zones: Zone[];
  owner: number[];
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
