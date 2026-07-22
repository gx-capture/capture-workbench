use std::process::{Child, Command, Stdio};

/// Terminates exactly the child PID tree created by this harness.
pub(crate) fn terminate_owned_process_tree(mut child: Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    #[cfg(windows)]
    {
        if terminate_windows_tree(child.id()).is_ok() {
            let _ = child.wait();
            return;
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate_windows_tree(pid: u32) -> Result<(), String> {
    let output = taskkill_command(pid)
        .output()
        .map_err(|error| format!("Failed to stop owned runtime process tree: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err("Owned runtime process tree did not stop cleanly.".into())
    }
}

#[cfg(any(windows, test))]
fn taskkill_command(pid: u32) -> Command {
    let mut command = Command::new("taskkill");
    command
        .args(taskkill_args(pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(any(windows, test))]
fn taskkill_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_targets_only_the_recorded_pid_tree() {
        let command = taskkill_command(4242);
        let args: Vec<_> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program().to_string_lossy(), "taskkill");
        assert_eq!(args, ["/PID", "4242", "/T", "/F"]);
        assert!(!args.iter().any(|arg| arg == "/IM"));
    }
}
