use std::{ffi::OsString, path::PathBuf};

const MIN_TOKEN_LENGTH: usize = 32;
pub(crate) const TOKEN_ENV_VAR: &str = "CAPTURE_DEV_HOST_TOKEN";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CliConfig {
    pub(crate) port: u16,
    pub(crate) app_data: PathBuf,
    pub(crate) runtime_manifest: PathBuf,
    pub(crate) runtime_executable: PathBuf,
}

pub(crate) fn parse_args<I>(args: I) -> Result<CliConfig, String>
where
    I: IntoIterator<Item = OsString>,
{
    let mut port: Option<u16> = None;
    let mut app_data: Option<PathBuf> = None;
    let mut runtime_manifest: Option<PathBuf> = None;
    let mut runtime_executable: Option<PathBuf> = None;

    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let flag = arg.to_string_lossy();
        let (name, inline_value) = match flag.split_once('=') {
            Some((name, value)) => (name.to_owned(), Some(OsString::from(value))),
            None => (flag.into_owned(), None),
        };
        match name.as_str() {
            "--port" => {
                if port.is_some() {
                    return Err("Duplicate --port argument.".into());
                }
                let raw = take_arg_value("--port", inline_value, &mut iter)?;
                let parsed = raw
                    .to_str()
                    .and_then(|value| value.parse::<u16>().ok())
                    .ok_or_else(|| "Invalid --port value.".to_string())?;
                port = Some(parsed);
            }
            "--app-data" => {
                if app_data.is_some() {
                    return Err("Duplicate --app-data argument.".into());
                }
                app_data = Some(PathBuf::from(take_arg_value(
                    "--app-data",
                    inline_value,
                    &mut iter,
                )?));
            }
            "--runtime-manifest" => {
                if runtime_manifest.is_some() {
                    return Err("Duplicate --runtime-manifest argument.".into());
                }
                runtime_manifest = Some(PathBuf::from(take_arg_value(
                    "--runtime-manifest",
                    inline_value,
                    &mut iter,
                )?));
            }
            "--runtime-executable" => {
                if runtime_executable.is_some() {
                    return Err("Duplicate --runtime-executable argument.".into());
                }
                runtime_executable = Some(PathBuf::from(take_arg_value(
                    "--runtime-executable",
                    inline_value,
                    &mut iter,
                )?));
            }
            other => return Err(format!("Unknown dev host argument: {other}")),
        }
    }

    Ok(CliConfig {
        port: port.unwrap_or(0),
        app_data: app_data.ok_or_else(|| "Missing required --app-data argument.".to_string())?,
        runtime_manifest: runtime_manifest
            .ok_or_else(|| "Missing required --runtime-manifest argument.".to_string())?,
        runtime_executable: runtime_executable
            .ok_or_else(|| "Missing required --runtime-executable argument.".to_string())?,
    })
}

fn take_arg_value<I>(
    name: &str,
    inline_value: Option<OsString>,
    iter: &mut I,
) -> Result<OsString, String>
where
    I: Iterator<Item = OsString>,
{
    let value = match inline_value {
        Some(value) => value,
        None => iter
            .next()
            .ok_or_else(|| format!("Missing value for {name}."))?,
    };
    if value.is_empty() {
        return Err(format!("Value for {name} must not be empty."));
    }
    Ok(value)
}

pub(crate) fn read_token_from_env() -> Result<String, String> {
    let token = std::env::var(TOKEN_ENV_VAR)
        .map_err(|_| format!("{TOKEN_ENV_VAR} is required and must be valid UTF-8."))?;
    validate_token(&token)?;
    // The token does not stay in the environment, so no process the host
    // starts later inherits it. This runs before any thread exists.
    std::env::remove_var(TOKEN_ENV_VAR);
    Ok(token)
}

pub(super) fn validate_token(token: &str) -> Result<(), String> {
    if token.len() < MIN_TOKEN_LENGTH
        || token
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(format!(
            "{TOKEN_ENV_VAR} must be at least {MIN_TOKEN_LENGTH} non-whitespace characters."
        ));
    }
    Ok(())
}
