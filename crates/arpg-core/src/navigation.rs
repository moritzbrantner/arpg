//! Room-local pursuit navigation (#65).
//!
//! ARPG owns the tactical path; `physics-engine` moves the body along it. A room is
//! rasterized into cells whose body-sized footprint is clear of every fixed obstacle,
//! and the shared `graph-kernels` A* searches that grid.

use graph_kernels::astar;

/// Cell edge in world units.
pub(crate) const NAV_CELL_SIZE: i32 = 20;
const STRAIGHT_COST: u64 = 10;
const DIAGONAL_COST: u64 = 14;

/// An axis-aligned XZ rectangle.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Rect {
    pub(crate) min_x: i32,
    pub(crate) max_x: i32,
    pub(crate) min_z: i32,
    pub(crate) max_z: i32,
}

impl Rect {
    pub(crate) fn centered(x: i32, z: i32, half_x: i32, half_z: i32) -> Self {
        Self {
            min_x: x - half_x,
            max_x: x + half_x,
            min_z: z - half_z,
            max_z: z + half_z,
        }
    }

    /// Strict overlap: rectangles that only touch do not overlap.
    fn overlaps(self, other: Self) -> bool {
        self.min_x < other.max_x
            && other.min_x < self.max_x
            && self.min_z < other.max_z
            && other.min_z < self.max_z
    }
}

type Cell = (i32, i32);

/// Passability of one room for a body with the given XZ clearance (half extent).
pub(crate) struct RoomGrid {
    bounds: Rect,
    columns: i32,
    rows: i32,
    free: Vec<bool>,
}

impl RoomGrid {
    pub(crate) fn new(bounds: Rect, obstacles: &[Rect], clearance: i32) -> Self {
        let columns = ((bounds.max_x - bounds.min_x) / NAV_CELL_SIZE).max(1);
        let rows = ((bounds.max_z - bounds.min_z) / NAV_CELL_SIZE).max(1);
        let mut grid = Self {
            bounds,
            columns,
            rows,
            free: Vec::with_capacity(usize::try_from(columns * rows).unwrap_or(0)),
        };
        for row in 0..rows {
            for column in 0..columns {
                let (x, z) = grid.cell_center((column, row));
                let footprint = Rect::centered(x, z, clearance, clearance);
                let inside = footprint.min_x >= bounds.min_x
                    && footprint.max_x <= bounds.max_x
                    && footprint.min_z >= bounds.min_z
                    && footprint.max_z <= bounds.max_z;
                grid.free.push(
                    inside
                        && !obstacles
                            .iter()
                            .any(|obstacle| footprint.overlaps(*obstacle)),
                );
            }
        }
        grid
    }

    fn cell_center(&self, (column, row): Cell) -> (i32, i32) {
        (
            self.bounds.min_x + column * NAV_CELL_SIZE + NAV_CELL_SIZE / 2,
            self.bounds.min_z + row * NAV_CELL_SIZE + NAV_CELL_SIZE / 2,
        )
    }

    fn cell_at(&self, x: i32, z: i32) -> Cell {
        (
            ((x - self.bounds.min_x) / NAV_CELL_SIZE).clamp(0, self.columns - 1),
            ((z - self.bounds.min_z) / NAV_CELL_SIZE).clamp(0, self.rows - 1),
        )
    }

    fn is_free(&self, (column, row): Cell) -> bool {
        column >= 0
            && row >= 0
            && column < self.columns
            && row < self.rows
            && self.free[usize::try_from(row * self.columns + column).unwrap_or(usize::MAX)]
    }

    /// Whether every cell the straight segment passes through is free, including both
    /// neighbours where it crosses exactly through a cell corner.
    pub(crate) fn segment_is_free(&self, from: (i32, i32), to: (i32, i32)) -> bool {
        let (mut column, mut row) = self.cell_at(from.0, from.1);
        let end = self.cell_at(to.0, to.1);
        if !self.is_free((column, row)) {
            return false;
        }
        let x0 = i64::from(from.0 - self.bounds.min_x);
        let z0 = i64::from(from.1 - self.bounds.min_z);
        let dx = i64::from(to.0 - from.0);
        let dz = i64::from(to.1 - from.1);
        let (step_x, step_z) = (dx.signum() as i32, dz.signum() as i32);
        let size = i64::from(NAV_CELL_SIZE);
        for _ in 0..=(self.columns + self.rows) {
            if (column, row) == end {
                return true;
            }
            // Compare the parameters of the next x and z boundary crossings exactly.
            let boundary = |cell: i32, step: i32| i64::from(cell + i32::from(step > 0)) * size;
            let to_x = if step_x == 0 {
                i64::MAX
            } else {
                (boundary(column, step_x) - x0).abs() * dz.abs()
            };
            let to_z = if step_z == 0 {
                i64::MAX
            } else {
                (boundary(row, step_z) - z0).abs() * dx.abs()
            };
            if to_x < to_z {
                column += step_x;
            } else if to_z < to_x {
                row += step_z;
            } else {
                if !self.is_free((column + step_x, row)) || !self.is_free((column, row + step_z)) {
                    return false;
                }
                column += step_x;
                row += step_z;
            }
            if !self.is_free((column, row)) {
                return false;
            }
        }
        false
    }

    /// The free cell holding `point`, or the first free neighbour in a fixed order: a body
    /// resting against an obstacle can sit in a cell whose centre is too close to it.
    fn free_cell_near(&self, (x, z): (i32, i32)) -> Option<Cell> {
        let cell = self.cell_at(x, z);
        std::iter::once(cell)
            .chain(neighbour_offsets().map(|(dx, dz, _)| (cell.0 + dx, cell.1 + dz)))
            .find(|&cell| self.is_free(cell))
    }

    /// Cell centres from `start` to a free cell within `reach` of `target` that has a clear
    /// line to it. `None` when no such cell is reachable. `searched` counts A* expansions.
    pub(crate) fn find_path(
        &self,
        start: (i32, i32),
        target: (i32, i32),
        reach: i64,
        searched: &mut u64,
    ) -> Option<Vec<(i32, i32)>> {
        let start = self.free_cell_near(start)?;
        let target_cell = self.cell_at(target.0, target.1);
        let reach_sq = reach * reach;
        let reach_cost = u64::try_from(reach).unwrap_or(0) * STRAIGHT_COST
            / u64::from(NAV_CELL_SIZE.unsigned_abs());
        let path = astar(
            start,
            |&cell| {
                let (x, z) = self.cell_center(cell);
                let dx = i64::from(target.0 - x);
                let dz = i64::from(target.1 - z);
                dx * dx + dz * dz <= reach_sq && self.segment_is_free((x, z), target)
            },
            |&cell| {
                *searched += 1;
                neighbour_offsets()
                    .filter(move |&(dx, dz, _)| {
                        let next = (cell.0 + dx, cell.1 + dz);
                        // No corner cutting: a diagonal needs both orthogonal cells free.
                        self.is_free(next)
                            && (dx == 0
                                || dz == 0
                                || (self.is_free((cell.0 + dx, cell.1))
                                    && self.is_free((cell.0, cell.1 + dz))))
                    })
                    .map(move |(dx, dz, cost)| ((cell.0 + dx, cell.1 + dz), cost))
                    .collect::<Vec<_>>()
            },
            |&cell| octile_cost(cell, target_cell).saturating_sub(reach_cost),
        )?;
        Some(
            path.nodes
                .into_iter()
                .map(|cell| self.cell_center(cell))
                .collect(),
        )
    }
}

fn neighbour_offsets() -> impl Iterator<Item = (i32, i32, u64)> {
    [
        (1, 0, STRAIGHT_COST),
        (-1, 0, STRAIGHT_COST),
        (0, 1, STRAIGHT_COST),
        (0, -1, STRAIGHT_COST),
        (1, 1, DIAGONAL_COST),
        (1, -1, DIAGONAL_COST),
        (-1, 1, DIAGONAL_COST),
        (-1, -1, DIAGONAL_COST),
    ]
    .into_iter()
}

fn octile_cost(from: Cell, to: Cell) -> u64 {
    let dx = u64::from((from.0 - to.0).unsigned_abs());
    let dz = u64::from((from.1 - to.1).unsigned_abs());
    STRAIGHT_COST * dx.max(dz) + (DIAGONAL_COST - STRAIGHT_COST) * dx.min(dz)
}

/// Integer square root (floor).
pub(crate) fn isqrt(value: i64) -> i64 {
    if value <= 0 {
        return 0;
    }
    let mut root = (value as f64).sqrt() as i64;
    while root * root > value {
        root -= 1;
    }
    while (root + 1) * (root + 1) <= value {
        root += 1;
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: Rect = Rect {
        min_x: 0,
        max_x: 400,
        min_z: 0,
        max_z: 400,
    };

    /// Independent reference: breadth-first reachability over the same free cells.
    fn reachable_cells(grid: &RoomGrid, start: Cell) -> usize {
        let mut seen = vec![start];
        let mut frontier = vec![start];
        while let Some(cell) = frontier.pop() {
            for (dx, dz, _) in neighbour_offsets().filter(|(dx, dz, _)| *dx == 0 || *dz == 0) {
                let next = (cell.0 + dx, cell.1 + dz);
                if grid.is_free(next) && !seen.contains(&next) {
                    seen.push(next);
                    frontier.push(next);
                }
            }
        }
        seen.len()
    }

    #[test]
    fn clearance_blocks_cells_whose_footprint_touches_walls_or_obstacles() {
        let pillar = Rect::centered(200, 200, 20, 60);
        let grid = RoomGrid::new(ROOM, &[pillar], 30);

        assert!(!grid.is_free(grid.cell_at(10, 200)));
        assert!(!grid.is_free(grid.cell_at(200, 200)));
        assert!(!grid.is_free(grid.cell_at(235, 200)));
        assert!(grid.is_free(grid.cell_at(260, 200)));
        assert!(grid.is_free(grid.cell_at(60, 60)));
    }

    #[test]
    fn path_goes_around_an_obstacle_and_ends_with_a_clear_line_in_reach() {
        let wall = Rect::centered(200, 160, 20, 160);
        let grid = RoomGrid::new(ROOM, &[wall], 30);
        let mut searched = 0;

        let path = grid
            .find_path((100, 100), (300, 100), 60, &mut searched)
            .expect("the target is reachable around the wall");

        assert!(searched > 0);
        assert!(
            path.iter().any(|&(_, z)| z > 320),
            "the path rounds the wall end"
        );
        let &(x, z) = path.last().unwrap();
        assert!(i64::from((300 - x).pow(2) + (100 - z).pow(2)) <= 60 * 60);
        assert!(grid.segment_is_free((x, z), (300, 100)));
        assert!(
            path.windows(2)
                .all(|step| grid.segment_is_free(step[0], step[1]))
        );
    }

    #[test]
    fn enclosed_targets_are_unreachable_like_the_reference_search_says() {
        let walls = [
            Rect::centered(300, 200, 10, 120),
            Rect::centered(200, 330, 110, 10),
            Rect::centered(200, 70, 110, 10),
        ];
        let open = RoomGrid::new(ROOM, &walls, 30);
        let mut closed_walls = walls.to_vec();
        closed_walls.push(Rect::centered(100, 200, 10, 120));
        let closed = RoomGrid::new(ROOM, &closed_walls, 30);
        let mut searched = 0;

        assert!(
            open.find_path((30, 30), (200, 200), 40, &mut searched)
                .is_some()
        );
        assert!(
            closed
                .find_path((30, 30), (200, 200), 40, &mut searched)
                .is_none()
        );
        let start = closed.cell_at(30, 30);
        let target = closed.cell_at(200, 200);
        assert!(closed.is_free(target));
        assert!(reachable_cells(&closed, start) < reachable_cells(&open, start));
    }

    #[test]
    fn identical_inputs_give_identical_paths() {
        let pillar = Rect::centered(200, 200, 20, 60);
        let grid = RoomGrid::new(ROOM, &[pillar], 30);
        let mut searched = 0;
        let first = grid.find_path((60, 200), (340, 200), 50, &mut searched);
        let second = grid.find_path((60, 200), (340, 200), 50, &mut searched);

        assert!(first.is_some());
        assert_eq!(first, second);
    }

    #[test]
    fn integer_square_root_floors() {
        assert_eq!(
            [0, 1, 3, 4, 99, 100, 101].map(isqrt),
            [0, 1, 1, 2, 9, 10, 10]
        );
    }
}
