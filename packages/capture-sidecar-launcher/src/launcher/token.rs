use std::fmt::Write as _;

use rand::{rngs::OsRng, RngCore};

/// Generates a fresh 256-bit bearer token encoded as lowercase hexadecimal.
///
/// Reads 32 bytes from the operating-system generator and formats them as 64
/// hex characters. The token is not logged or written to disk.
///
/// # Errors
///
/// Returns `Err(String)` when the generator cannot fill the buffer or the
/// hex encoding cannot be written.
pub fn generate_bearer_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "A secure runtime bearer token could not be generated.".to_string())?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut token, "{byte:02x}")
            .map_err(|_| "A secure runtime bearer token could not be encoded.".to_string())?;
    }
    Ok(token)
}
