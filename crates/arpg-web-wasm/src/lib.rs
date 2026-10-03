#![forbid(unsafe_code)]

use arpg_core::{ArpgGame, AuthoritativeGame, PlayerCommand};
use arpg_protocol::{JsonProtocol, WireProtocol};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmGame {
    game: ArpgGame,
    protocol: JsonProtocol,
}

#[wasm_bindgen]
impl WasmGame {
    #[wasm_bindgen(constructor)]
    pub fn new(run_seed: u32) -> Result<WasmGame, JsValue> {
        Ok(Self {
            game: ArpgGame::new_with_seed(run_seed).map_err(js_error)?,
            protocol: JsonProtocol,
        })
    }

    #[wasm_bindgen(js_name = tickHz)]
    pub fn tick_hz(&self) -> u16 {
        self.game.tick_hz()
    }

    #[wasm_bindgen(js_name = addPlayer)]
    pub fn add_player(&mut self, player_id: u32) -> Result<(), JsValue> {
        self.game.add_player(player_id).map_err(js_error)
    }

    #[wasm_bindgen(js_name = removePlayer)]
    pub fn remove_player(&mut self, player_id: u32) -> bool {
        self.game.remove_player(player_id)
    }

    #[wasm_bindgen(js_name = applyCommand)]
    pub fn apply_command(
        &mut self,
        player_id: u32,
        sequence: u32,
        encoded_command: &str,
    ) -> Result<(), JsValue> {
        let command = self
            .protocol
            .decode_command(encoded_command.as_bytes())
            .map_err(js_error)?;
        let command = PlayerCommand::new(player_id, sequence, command).map_err(js_error)?;
        self.game.apply_command(command).map_err(js_error)
    }

    #[wasm_bindgen(js_name = advanceTick)]
    pub fn advance_tick(&mut self) -> Result<(), JsValue> {
        self.game.advance_tick().map_err(js_error)
    }

    #[wasm_bindgen(js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        let snapshot = self.game.snapshot().map_err(js_error)?;
        let bytes = self.protocol.encode_snapshot(&snapshot).map_err(js_error)?;
        String::from_utf8(bytes).map_err(js_error)
    }
}

fn js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}
