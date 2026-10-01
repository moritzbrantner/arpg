use arpg_core::ArpgGame;
use arpg_game_server::GameServerAdapter;
use arpg_protocol::JsonProtocol;
use game_server::{DEFAULT_RECONNECT_GRACE_TICKS, WebTransportConfig, serve_with_shutdown};
use std::env;
use std::error::Error;
use std::path::PathBuf;
use std::process;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

#[path = "server/config.rs"]
mod config;

const DEFAULT_PORT: u16 = 4433;
const DEFAULT_DRAIN_GRACE_MS: u64 = 500;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let port = config::configured_number(
        "ARPG_SERVER_PORT",
        environment_value("ARPG_SERVER_PORT")?.as_deref(),
        DEFAULT_PORT,
    )?;
    let certificate_pem = PathBuf::from(
        environment_value("ARPG_SERVER_CERT_PEM")?.unwrap_or_else(|| "cert.pem".to_owned()),
    );
    let private_key_pem = PathBuf::from(
        environment_value("ARPG_SERVER_KEY_PEM")?.unwrap_or_else(|| "key.pem".to_owned()),
    );
    let session_path =
        environment_value("ARPG_SERVER_SESSION_PATH")?.unwrap_or_else(|| "/arpg".to_owned());
    let recovery_path = environment_value("ARPG_SERVER_RECOVERY_PATH")?.map(PathBuf::from);
    let drain_grace_ms = config::configured_number(
        "ARPG_SERVER_DRAIN_GRACE_MS",
        environment_value("ARPG_SERVER_DRAIN_GRACE_MS")?.as_deref(),
        DEFAULT_DRAIN_GRACE_MS,
    )?;
    let run_seed = selected_run_seed()?;

    eprintln!("event=arpg_server_start run_seed={run_seed}");
    let simulation = GameServerAdapter::new(ArpgGame::new_with_seed(run_seed)?, JsonProtocol);
    let (shutdown_sender, shutdown_receiver) = mpsc::channel(1);
    let shutdown_forwarder = install_shutdown_forwarder(shutdown_sender)?;

    let result = serve_with_shutdown(
        simulation,
        DEFAULT_RECONNECT_GRACE_TICKS,
        WebTransportConfig {
            port,
            certificate_pem,
            private_key_pem,
            session_path,
            recovery_path,
            drain_grace: Duration::from_millis(drain_grace_ms),
        },
        shutdown_receiver,
    )
    .await;
    shutdown_forwarder.abort();
    if let Err(error) = shutdown_forwarder.await
        && !error.is_cancelled()
    {
        return Err(error.into());
    }
    result?;
    Ok(())
}

fn selected_run_seed() -> Result<u32, Box<dyn Error>> {
    if let Some(value) = environment_value("ARPG_RUN_SEED")? {
        return Ok(value.parse()?);
    }

    let nanos = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    Ok((nanos as u32) ^ ((nanos >> 32) as u32) ^ ((nanos >> 64) as u32) ^ process::id())
}

fn environment_value(name: &str) -> Result<Option<String>, env::VarError> {
    match env::var(name) {
        Ok(value) => Ok(Some(value)),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn install_shutdown_forwarder(
    sender: mpsc::Sender<()>,
) -> Result<tokio::task::JoinHandle<()>, Box<dyn Error>> {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate())?;
    Ok(tokio::spawn(async move {
        let signal_received = tokio::select! {
            result = tokio::signal::ctrl_c() => match result {
                Ok(()) => true,
                Err(error) => {
                    eprintln!("event=shutdown_signal_error error={error:?}");
                    false
                }
            },
            received = terminate.recv() => received.is_some(),
        };
        if signal_received {
            // Receiver closure means the serving lifecycle already ended.
            if sender.send(()).await.is_err() {
                eprintln!("event=shutdown_receiver_closed");
            }
        }
    }))
}

#[cfg(not(unix))]
fn install_shutdown_forwarder(
    sender: mpsc::Sender<()>,
) -> Result<tokio::task::JoinHandle<()>, Box<dyn Error>> {
    Ok(tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => {
                // Receiver closure means the serving lifecycle already ended.
                if sender.send(()).await.is_err() {
                    eprintln!("event=shutdown_receiver_closed");
                }
            }
            Err(error) => eprintln!("event=shutdown_signal_error error={error:?}"),
        }
    }))
}
