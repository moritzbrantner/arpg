#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt;

use arpg_core::{ArpgCommand, ArpgSnapshot};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const PROTOCOL_VERSION: u16 = 2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtocolError {
    message: String,
}

impl ProtocolError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for ProtocolError {}

/// Game-specific command/snapshot encoding independent of transport topology.
pub trait WireProtocol<Command, Snapshot>: Send + Sync + 'static {
    fn encode_command(&self, command: &Command) -> Result<Vec<u8>, ProtocolError>;
    fn decode_command(&self, payload: &[u8]) -> Result<Command, ProtocolError>;
    fn encode_snapshot(&self, snapshot: &Snapshot) -> Result<Vec<u8>, ProtocolError>;
    fn decode_snapshot(&self, payload: &[u8]) -> Result<Snapshot, ProtocolError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct JsonProtocol;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionedPayload<T> {
    protocol_version: u16,
    payload: T,
}

impl WireProtocol<ArpgCommand, ArpgSnapshot> for JsonProtocol {
    fn encode_command(&self, command: &ArpgCommand) -> Result<Vec<u8>, ProtocolError> {
        encode(command)
    }

    fn decode_command(&self, payload: &[u8]) -> Result<ArpgCommand, ProtocolError> {
        decode(payload)
    }

    fn encode_snapshot(&self, snapshot: &ArpgSnapshot) -> Result<Vec<u8>, ProtocolError> {
        encode(snapshot)
    }

    fn decode_snapshot(&self, payload: &[u8]) -> Result<ArpgSnapshot, ProtocolError> {
        decode(payload)
    }
}

fn encode<T: Serialize + Clone>(payload: &T) -> Result<Vec<u8>, ProtocolError> {
    serde_json::to_vec(&VersionedPayload {
        protocol_version: PROTOCOL_VERSION,
        payload: payload.clone(),
    })
    .map_err(|error| ProtocolError::new(format!("encode failed: {error}")))
}

fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ProtocolError> {
    let envelope: VersionedPayload<T> = serde_json::from_slice(bytes)
        .map_err(|error| ProtocolError::new(format!("decode failed: {error}")))?;
    if envelope.protocol_version != PROTOCOL_VERSION {
        return Err(ProtocolError::new(format!(
            "unsupported ARPG protocol version {}",
            envelope.protocol_version
        )));
    }
    Ok(envelope.payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    use arpg_core::{ArpgGame, AuthoritativeGame};

    #[test]
    fn command_round_trip_is_versioned() {
        let protocol = JsonProtocol;
        let command = ArpgCommand::SetMovement { x: -1, z: 1 };
        let bytes = protocol.encode_command(&command).unwrap();
        let encoded = String::from_utf8(bytes.clone()).unwrap();
        assert!(encoded.contains("\"protocolVersion\":2"));
        assert_eq!(protocol.decode_command(&bytes).unwrap(), command);
    }

    #[test]
    fn snapshot_round_trip_preserves_authoritative_run_seed() {
        let mut game = ArpgGame::new_with_seed(0xCAFE_BABE).unwrap();
        game.add_player(1).unwrap();
        let snapshot = game.snapshot().unwrap();
        let protocol = JsonProtocol;
        let bytes = protocol.encode_snapshot(&snapshot).unwrap();
        let decoded = protocol.decode_snapshot(&bytes).unwrap();
        assert_eq!(decoded, snapshot);
        assert_eq!(decoded.run_seed, 0xCAFE_BABE);
        assert_eq!(decoded.schema_version, 2);
    }
}
