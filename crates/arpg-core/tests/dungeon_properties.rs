use std::collections::{BTreeMap, BTreeSet, VecDeque};

use arpg_core::{ArpgGame, AuthoritativeGame, RoomKind, RoomSnapshot, StaticColliderSnapshot};

const SEED_COUNT: u32 = 512;

#[test]
fn generated_dungeons_satisfy_public_invariants_across_seed_sweep() {
    for seed in 0..SEED_COUNT {
        let mut game = ArpgGame::new_with_seed(seed).expect("seeded dungeon must construct");
        for player_id in 1..=4 {
            game.add_player(player_id)
                .expect("four-player spawn fixture must remain valid");
        }
        let snapshot = game.snapshot().expect("generated dungeon must snapshot");

        assert_eq!(snapshot.run_seed, seed, "seed {seed}");
        assert_eq!(snapshot.players.len(), 4, "seed {seed}");
        assert!(!snapshot.rooms.is_empty(), "seed {seed}");
        assert!(!snapshot.doors.is_empty(), "seed {seed}");
        assert!(!snapshot.static_colliders.is_empty(), "seed {seed}");

        let rooms = snapshot
            .rooms
            .iter()
            .map(|room| (room.id, room))
            .collect::<BTreeMap<_, _>>();
        let start_rooms = snapshot
            .rooms
            .iter()
            .filter(|room| room.kind == RoomKind::Start)
            .collect::<Vec<_>>();
        assert_eq!(start_rooms.len(), 1, "seed {seed}");
        let start = start_rooms[0];

        assert_room_geometry(seed, &snapshot.rooms);
        assert_room_graph(seed, &snapshot.rooms, &snapshot.doors);
        assert_unique_ids(
            seed,
            "room",
            snapshot.rooms.iter().map(|room| u64::from(room.id)),
        );
        assert_unique_ids(seed, "door", snapshot.doors.iter().map(|door| door.id));
        assert_unique_ids(
            seed,
            "collider",
            snapshot.static_colliders.iter().map(|collider| collider.id),
        );
        assert_static_geometry(seed, &snapshot.static_colliders);

        let mut player_positions = BTreeSet::new();
        for player in &snapshot.players {
            let position = player.position;
            assert!(
                contains_xz(start, position[0], position[2]),
                "seed {seed}: player {} spawned outside start room",
                player.id
            );
            assert!(
                player_positions.insert(position),
                "seed {seed}: player spawns must be distinct"
            );
            assert!(
                snapshot
                    .static_colliders
                    .iter()
                    .all(|collider| !point_inside_collider(position, collider)),
                "seed {seed}: player {} spawned inside a fixed collider",
                player.id
            );
        }

        for monster in &snapshot.monsters {
            let room = rooms
                .get(&monster.room_id)
                .expect("monster must reference an existing room");
            assert_eq!(room.kind, RoomKind::Combat, "seed {seed}");
            assert!(
                contains_xz(room, monster.position[0], monster.position[2]),
                "seed {seed}: monster {} spawned outside room {}",
                monster.id,
                monster.room_id
            );
            assert!(
                snapshot
                    .static_colliders
                    .iter()
                    .all(|collider| !point_inside_collider(monster.position, collider)),
                "seed {seed}: monster {} spawned inside a fixed collider",
                monster.id
            );
        }
    }
}

#[test]
fn sampled_seeded_runs_replay_to_identical_authoritative_snapshots() {
    for seed in [0, 1, 2, 7, 42, 255, 65_535, u32::MAX] {
        let first = snapshot_for_seed(seed);
        let replay = snapshot_for_seed(seed);
        assert_eq!(first, replay, "seed {seed} must replay identically");
    }
}

fn snapshot_for_seed(seed: u32) -> arpg_core::ArpgSnapshot {
    let mut game = ArpgGame::new_with_seed(seed).expect("seeded dungeon must construct");
    for player_id in 1..=4 {
        game.add_player(player_id)
            .expect("four-player spawn fixture must remain valid");
    }
    game.snapshot().expect("seeded dungeon must snapshot")
}

fn assert_room_geometry(seed: u32, rooms: &[RoomSnapshot]) {
    for room in rooms {
        assert!(
            room.min_x < room.max_x,
            "seed {seed}: room {} x bounds",
            room.id
        );
        assert!(
            room.min_z < room.max_z,
            "seed {seed}: room {} z bounds",
            room.id
        );
    }

    for (index, left) in rooms.iter().enumerate() {
        for right in &rooms[index + 1..] {
            let overlaps_x = left.min_x < right.max_x && right.min_x < left.max_x;
            let overlaps_z = left.min_z < right.max_z && right.min_z < left.max_z;
            assert!(
                !(overlaps_x && overlaps_z),
                "seed {seed}: rooms {} and {} overlap",
                left.id,
                right.id
            );
        }
    }
}

fn assert_room_graph(seed: u32, rooms: &[RoomSnapshot], doors: &[arpg_core::DoorSnapshot]) {
    let room_by_id = rooms
        .iter()
        .map(|room| (room.id, room))
        .collect::<BTreeMap<_, _>>();
    let start = rooms
        .iter()
        .find(|room| room.kind == RoomKind::Start)
        .expect("generated dungeon needs a start room");

    let mut seen = BTreeSet::new();
    let mut pending = VecDeque::from([start.id]);
    while let Some(room_id) = pending.pop_front() {
        if !seen.insert(room_id) {
            continue;
        }
        let room = room_by_id
            .get(&room_id)
            .expect("room graph must reference existing room");
        for neighbor_id in &room.neighbors {
            let neighbor = room_by_id
                .get(neighbor_id)
                .expect("neighbor must reference existing room");
            assert!(
                neighbor.neighbors.contains(&room.id),
                "seed {seed}: room {} -> {} must be symmetric",
                room.id,
                neighbor.id
            );
            assert!(
                doors.iter().any(|door| {
                    (door.room_a == room.id && door.room_b == neighbor.id)
                        || (door.room_b == room.id && door.room_a == neighbor.id)
                }),
                "seed {seed}: room {} -> {} needs a door",
                room.id,
                neighbor.id
            );
            pending.push_back(*neighbor_id);
        }
    }
    assert_eq!(
        seen.len(),
        rooms.len(),
        "seed {seed}: graph must be connected"
    );

    let mut connections = BTreeSet::new();
    for door in doors {
        assert!(
            door.half_extents.iter().all(|extent| *extent > 0),
            "seed {seed}"
        );
        let room_a = room_by_id
            .get(&door.room_a)
            .expect("door room_a must exist");
        let room_b = room_by_id
            .get(&door.room_b)
            .expect("door room_b must exist");
        assert!(room_a.neighbors.contains(&room_b.id), "seed {seed}");
        assert!(room_b.neighbors.contains(&room_a.id), "seed {seed}");
        let pair = if door.room_a < door.room_b {
            (door.room_a, door.room_b)
        } else {
            (door.room_b, door.room_a)
        };
        assert!(
            connections.insert(pair),
            "seed {seed}: duplicate door connection {pair:?}"
        );
    }
}

fn assert_static_geometry(seed: u32, colliders: &[StaticColliderSnapshot]) {
    for collider in colliders {
        assert!(
            collider.half_extents.iter().all(|extent| *extent > 0),
            "seed {seed}: collider {} has non-positive half extent",
            collider.id
        );
    }
}

fn assert_unique_ids(seed: u32, kind: &str, ids: impl IntoIterator<Item = u64>) {
    let mut seen = BTreeSet::new();
    for id in ids {
        assert!(seen.insert(id), "seed {seed}: duplicate {kind} id {id}");
    }
}

fn contains_xz(room: &RoomSnapshot, x: i32, z: i32) -> bool {
    x >= room.min_x && x <= room.max_x && z >= room.min_z && z <= room.max_z
}

fn point_inside_collider(position: [i32; 3], collider: &StaticColliderSnapshot) -> bool {
    (position[0] - collider.position[0]).abs() <= collider.half_extents[0]
        && (position[1] - collider.position[1]).abs() <= collider.half_extents[1]
        && (position[2] - collider.position[2]).abs() <= collider.half_extents[2]
}
