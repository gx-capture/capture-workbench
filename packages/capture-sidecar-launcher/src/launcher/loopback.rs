use std::{collections::HashSet, net::TcpListener};

use crate::constants::LOOPBACK_HOST;

/// Reserves one ephemeral loopback port and releases the listener immediately.
pub fn reserve_loopback_port() -> Result<u16, String> {
    TcpListener::bind((LOOPBACK_HOST, 0))
        .map_err(|error| format!("A loopback runtime port could not be reserved: {error}"))?
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("The reserved loopback port could not be read: {error}"))
}

/// Reserves an ephemeral loopback port not present in the supplied set.
pub fn reserve_distinct_loopback_port(excluded: &HashSet<u16>) -> Result<u16, String> {
    for _ in 0..32 {
        let candidate = reserve_loopback_port()?;
        if !excluded.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err("A fresh independent loopback port could not be reserved.".into())
}
