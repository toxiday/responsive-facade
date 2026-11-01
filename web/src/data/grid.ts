// Floor grid convention, identical to the pipeline (docs/guidelines.md §5):
// 32×32 cells, row 0 = the +Y (N) edge, col 0 = the x=0 (W) edge, zones by cell centre.
// Python reference: live_solver.cell_centres (x = (c+.5)W/32, y = (31.5-r)D/32).

export const GRID_N = 32;

export interface Cell {
  row: number;
  col: number;
}

/** Room-frame centre (metres) of floor cell (row, col). */
export function cellCentre(row: number, col: number, width: number, depth: number) {
  return {
    x: ((col + 0.5) * width) / GRID_N,
    y: ((GRID_N - 0.5 - row) * depth) / GRID_N,
  };
}

/** Floor cell containing room point (x, y); points outside the room clamp to the edge. */
export function cellOf(x: number, y: number, width: number, depth: number): Cell {
  const clamp = (v: number) => Math.min(GRID_N - 1, Math.max(0, v));
  return {
    row: clamp(Math.floor(((depth - y) / depth) * GRID_N)),
    col: clamp(Math.floor((x / width) * GRID_N)),
  };
}

/** Flat index into a row-major 32×32 array (row * 32 + col). */
export function cellIndex(cell: Cell): number {
  return cell.row * GRID_N + cell.col;
}
