#![forbid(unsafe_code)]

use std::error::Error;
use std::fmt;

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
///
/// The same codec is consumed by dedicated-server WebTransport and by the
/// browser peer-host path after WebRTC connectivity has been established.
pub trait WireProtocol<Command, Snapshot>: Send + Sync + 'static {
    fn encode_command(&self, command: &Command) -> Result<Vec<u8>, ProtocolError>;
    fn decode_command(&self, payload: &[u8]) -> Result<Command, ProtocolError>;
    fn encode_snapshot(&self, snapshot: &Snapshot) -> Result<Vec<u8>, ProtocolError>;
    fn decode_snapshot(&self, payload: &[u8]) -> Result<Snapshot, ProtocolError>;
}
