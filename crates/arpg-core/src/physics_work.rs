//! Actual game-owned compatibility-world work assertions; no shadow physics implementation.
use super::{
    physics_workloads::{Case, fixture, timed_tick},
    *,
};

#[test]
fn quiet_game_ticks_reuse_stationary_validation_and_commit_no_physical_fields() {
    for case in [Case::Quiet, Case::PartyQuiet] {
        let mut game = fixture(case, 42);
        game.advance_tick().unwrap();
        let before = game.world.bodies().cloned().collect::<Vec<_>>();
        for _ in 0..64 {
            let (_, sample) = timed_tick(&mut game);
            let work = sample.stats.work;
            assert!(work.cached_stationary_step);
            assert_eq!(work.staged_bodies, 0);
            assert_eq!(work.quantized_bodies, 0);
            assert_eq!(work.body_map_rebuilds, 0);
            assert_eq!(work.body_map_insertions, 0);
            assert_eq!(work.committed_position_deltas, 0);
            assert_eq!(work.committed_velocity_deltas, 0);
            assert_eq!(work.sweep_bound_preparations, 0);
            assert_eq!(game.world.bodies().cloned().collect::<Vec<_>>(), before);
        }
    }
}
#[test]
fn one_moving_player_changes_only_its_position_and_keeps_the_body_map() {
    let mut game = fixture(Case::Sparse, 42);
    game.apply_command(PlayerCommand::new(1, 1, ArpgCommand::SetMovement { x: 1, z: 0 }).unwrap())
        .unwrap();
    let (_, sample) = timed_tick(&mut game);
    let work = sample.stats.work;
    assert!(!work.cached_stationary_step);
    assert_eq!(work.initially_moving_bodies, 1);
    assert_eq!(work.committed_position_deltas, 1);
    assert_eq!(work.body_map_rebuilds, 0);
    assert_eq!(work.body_map_insertions, 0);
    // Staging/broad-phase preparation still visits N: this is not the remaining K-only repair.
    assert_eq!(work.staged_bodies, sample.stats.body_count);
}
