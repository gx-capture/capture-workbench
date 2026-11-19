use std::{collections::HashSet, net::TcpListener};

use crate::constants::LOOPBACK_HOST;

/// Picks a currently free `127.0.0.1` port by binding and releasing a listener.
///
/// Another process can bind the port before the sidecar does. The caller
/// must handle that race. When the sidecar exits before readiness, the
/// launcher can retry with a new launch spec, subject to its retry policy.
///
/// # Errors
///
/// Returns `Err(String)` when the bind fails or the bound address cannot be
/// read.
pub fn pick_free_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A free loopback port could not be picked: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The bound loopback port could not be read: {error}"))
}

/// Picks a currently free `127.0.0.1` port outside `excluded`.
///
/// Tries [`pick_free_loopback_port`] up to 32 times. Each try binds a port and
/// drops the listener immediately. The caller must handle the same bind race
/// described in [`pick_free_loopback_port`].
///
/// # Errors
///
/// Returns `Err(String)` when a bind fails or all 32 candidates were in
/// `excluded`.
pub fn pick_distinct_free_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = pick_free_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A distinct free loopback port could not be picked.".into())
}
