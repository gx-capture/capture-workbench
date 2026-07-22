mod contract;
mod http;

use std::{
    env,
    net::{TcpListener, TcpStream},
    process,
    sync::Arc,
    thread,
};

use contract::{FixtureSettings, FixtureState};
use http::{read_request, write_response, AuthorizationDecision, LocalRequestPolicy};

fn main() {
    let (host, port) = parse_args().unwrap_or_else(|error| exit_with_error(&error));
    if host != "127.0.0.1" {
        exit_with_error("Deterministic runtime binds to 127.0.0.1 only.");
    }
    let settings = FixtureSettings::from_env().unwrap_or_else(|error| exit_with_error(&error));
    let policy = Arc::new(
        LocalRequestPolicy::from_env(&settings.api_token)
            .unwrap_or_else(|error| exit_with_error(&error)),
    );
    let state = Arc::new(FixtureState::new(settings));
    let listener = TcpListener::bind((host.as_str(), port))
        .unwrap_or_else(|_| exit_with_error("Deterministic runtime could not bind."));

    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            continue;
        };
        let policy = Arc::clone(&policy);
        let state = Arc::clone(&state);
        thread::spawn(move || handle_connection(stream, &policy, &state));
    }
}

fn handle_connection(mut stream: TcpStream, policy: &LocalRequestPolicy, state: &FixtureState) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(response) => {
            write_response(&mut stream, response);
            return;
        }
    };
    let origin = request.headers.get("origin").cloned();
    let response = match policy.authorize(&request) {
        AuthorizationDecision::Authorized => state.route(request),
        AuthorizationDecision::Respond(response) => response,
    };
    write_response(
        &mut stream,
        response.with_cors(policy.permitted_origin(origin.as_deref())),
    );
}

fn parse_args() -> Result<(String, u16), String> {
    let mut args = env::args().skip(1);
    if args.next().as_deref() != Some("serve") {
        return Err("Deterministic runtime requires the serve command.".into());
    }
    let mut host = None;
    let mut port = None;
    while let Some(name) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("Missing value for {name}."))?;
        match name.as_str() {
            "--host" => host = Some(value),
            "--port" => {
                port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| "Runtime port is invalid.".to_string())?,
                )
            }
            _ => return Err(format!("Unknown argument {name}.")),
        }
    }
    Ok((
        host.unwrap_or_else(|| "127.0.0.1".into()),
        port.ok_or_else(|| "Runtime port is required.".to_string())?,
    ))
}

fn exit_with_error(message: &str) -> ! {
    eprintln!("{message}");
    process::exit(2)
}
