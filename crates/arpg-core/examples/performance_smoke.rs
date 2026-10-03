use std::time::Instant;

use arpg_core::{ArpgCommand, ArpgGame, AuthoritativeGame, PlayerCommand};

const RUNS: usize = 3;
const TICKS: u64 = 3_600;
/// Blocking budget declared for `physics_steps` in `.performance/contract.json`.
const MAX_PHYSICS_STEPS: u64 = 3_600;

fn run_journey() -> (arpg_core::ArpgSnapshot, u64) {
    let mut game = ArpgGame::new().expect("built-in ARPG fixture must be valid");
    for player_id in 1..=4 {
        game.add_player(player_id)
            .expect("player fixture must be valid");
    }

    let mut sequences = [1_u32; 4];
    for tick in 0..TICKS {
        if tick % 300 == 0 {
            for player_id in 1..=4 {
                let index = usize::try_from(player_id - 1).expect("bounded player index");
                let phase = ((tick / 300) + u64::from(player_id)) % 4;
                let (x, z) = match phase {
                    0 => (1, 0),
                    1 => (0, 1),
                    2 => (-1, 0),
                    _ => (0, -1),
                };
                game.apply_command(
                    PlayerCommand::new(
                        player_id,
                        sequences[index],
                        ArpgCommand::SetMovement { x, z },
                    )
                    .expect("movement command sequence is valid"),
                )
                .expect("movement command must remain valid");
                sequences[index] += 1;
            }
        }

        if tick % 90 == 0 {
            for player_id in 1..=4 {
                let index = usize::try_from(player_id - 1).expect("bounded player index");
                game.apply_command(
                    PlayerCommand::new(player_id, sequences[index], ArpgCommand::PrimaryAttack)
                        .expect("attack command sequence is valid"),
                )
                .expect("attack command must remain valid");
                sequences[index] += 1;
            }
        }

        game.advance_tick().expect("ARPG tick must remain valid");
        if tick % 60 == 0 {
            let snapshot = game.snapshot().expect("ARPG snapshot must remain valid");
            assert_eq!(snapshot.tick, tick + 1);
        }
    }

    let snapshot = game
        .snapshot()
        .expect("final ARPG snapshot must remain valid");
    (snapshot, game.physics_steps())
}

fn main() {
    let mut elapsed_ns = Vec::with_capacity(RUNS);
    let mut expected = None;
    let mut physics_steps = None;

    for _ in 0..RUNS {
        let started = Instant::now();
        let (snapshot, steps) = run_journey();
        elapsed_ns.push(started.elapsed().as_nanos());
        assert!(
            steps <= MAX_PHYSICS_STEPS,
            "ARPG performance journey stepped physics {steps} times, budget is {MAX_PHYSICS_STEPS}"
        );
        if let Some(reference) = physics_steps {
            assert_eq!(
                steps, reference,
                "ARPG physics step count became nondeterministic"
            );
        } else {
            physics_steps = Some(steps);
        }
        if let Some(reference) = &expected {
            assert_eq!(
                &snapshot, reference,
                "ARPG performance journey became nondeterministic"
            );
        } else {
            expected = Some(snapshot);
        }
    }

    elapsed_ns.sort_unstable();
    let snapshot = expected.expect("at least one run");
    let physics_steps = physics_steps.expect("at least one run");
    println!(
        "scenario=four-player-combat ticks={TICKS} runs={RUNS} median_elapsed_ns={} physics_steps={physics_steps} physics_steps_budget={MAX_PHYSICS_STEPS} players={} monsters={} static_colliders={} deterministic=true timing=advisory-shared-runner",
        elapsed_ns[RUNS / 2],
        snapshot.players.len(),
        snapshot.monsters.len(),
        snapshot.static_colliders.len(),
    );
}
