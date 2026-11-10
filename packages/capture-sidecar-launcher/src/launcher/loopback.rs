use std::{collections::HashSet, net::TcpListener};

use crate::constants::LOOPBACK_HOST;

/// Binds one ephemeral `127.0.0.1` port and releases the listener immediately.
///
/// The returned port is not held. Another process can bind it before the
/// sidecar starts.
///
/// # Errors
///
/// Returns `Err(String)` when the bind fails or the bound address cannot be
/// read.
pub fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

/// Binds an ephemeral `127.0.0.1` port that is not in `excluded`.
///
/// Tries [`reserve_loopback_port`] up to 32 times. Each try binds a port and
/// drops the listener before the next try, so the returned port is not held.
///
/// # Errors
///
/// Returns `Err(String)` when a bind fails or all 32 candidates were in
/// `excluded`.
pub fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}
