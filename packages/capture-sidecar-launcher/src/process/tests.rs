use std::{
    path::PathBuf,
    process::{Command, Stdio},
};

#[cfg(windows)]
use windows_sys::Win32::{Foundation::*, System::Threading::*};

use super::error::*;
use super::native::*;
use super::sidecar_process::*;
use crate::OwnedRuntimeSession;

#[test]
fn cleanup_targets_only_the_recorded_pid_tree() {
    let command = taskkill_command(4242).expect("taskkill command");
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    assert_eq!(args, ["/PID", "4242", "/T", "/F"]);
    assert!(!args.iter().any(|arg| arg == "/IM"));
}

#[cfg(windows)]
#[test]
fn runtime_process_is_assigned_to_an_owned_job() {
    let mut command = Command::new("cmd.exe");
    command
        .args([
            "/D",
            "/S",
            "/C",
            "start \"\" /B ping.exe -n 30 127.0.0.1 >nul & ping.exe -n 30 127.0.0.1 >nul",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut process = OwnedSidecarProcess::spawn(&mut command).expect("owned process");
    assert!(process.id() > 0);
    assert!(process.try_wait().expect("status").is_none());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while process.active_processes().expect("active processes") < 2
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(process.active_processes().expect("descendant process") >= 2);
    assert!(!process.breakaway_allowed().expect("job limits"));
    assert!(process.assignment_verified_before_resume);
    process.terminate().expect("terminate owned process");
}

#[cfg(windows)]
#[test]
fn a_child_attempting_breakaway_is_rejected_by_the_owned_job() {
    let test_exe = std::env::current_exe().expect("test executable");
    let mut command = Command::new(test_exe);
    command
        .args([
            "--exact",
            "process::tests::breakaway_probe_child_entry",
            "--nocapture",
        ])
        .env("CAPTURE_BREAKAWAY_PROBE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let process = OwnedRuntimeSession::spawn(&mut command).expect("owned probe");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while process.try_wait().expect("probe status").is_none()
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let status = process
        .monitor_root_exit()
        .expect("probe cleanup")
        .expect("probe exit");
    assert_eq!(status.code(), Some(0));
}

#[cfg(windows)]
#[test]
fn breakaway_probe_child_entry() {
    if std::env::var_os("CAPTURE_BREAKAWAY_PROBE").is_none() {
        return;
    }
    assert_eq!(attempt_breakaway_child(), Err(ERROR_ACCESS_DENIED));
}

#[cfg(windows)]
fn attempt_breakaway_child() -> Result<(), u32> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr::null_mut};

    let executable = std::env::var_os("COMSPEC").ok_or(ERROR_ACCESS_DENIED)?;
    let executable: Vec<u16> = OsStr::new(&executable)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut command_line: Vec<u16> = OsStr::new("cmd.exe /D /S /C exit 0")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut process_information: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            executable.as_ptr(),
            command_line.as_mut_ptr(),
            null_mut(),
            null_mut(),
            0,
            CREATE_BREAKAWAY_FROM_JOB,
            null_mut(),
            null_mut(),
            &startup,
            &mut process_information,
        )
    };
    if created == 0 {
        return Err(unsafe { GetLastError() });
    }
    unsafe {
        CloseHandle(process_information.hThread);
        CloseHandle(process_information.hProcess);
    }
    Ok(())
}

#[cfg(windows)]
#[test]
fn runtime_session_termination_is_idempotent_and_proven() {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    let first = session
        .terminate_and_prove()
        .expect("first termination proof");
    let second = session
        .terminate_and_prove()
        .expect("idempotent termination proof");
    assert_eq!(first, second);
    assert!(first.root_reaped);
    assert!(first.descendants_terminated);
}

#[cfg(windows)]
#[test]
fn host_ownership_clone_survives_launcher_scope_until_cleanup_proof() {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let host_owned = {
        let launcher_owned = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        let host_owned = launcher_owned.clone();
        drop(launcher_owned);
        host_owned
    };

    let proof = host_owned
        .terminate_and_prove()
        .expect("host cleanup proof");
    assert!(proof.root_reaped);
    assert!(proof.descendants_terminated);
}

#[cfg(windows)]
#[test]
fn launcher_scope_drop_does_not_fake_cleanup_proof_for_host_owner() {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let launcher_owned = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    let host_owned = launcher_owned.clone();
    host_owned.inject_cleanup_failure_for_test();
    drop(launcher_owned);

    let failure = host_owned
        .terminate_and_prove()
        .expect_err("host must not observe a fabricated Drop proof");
    assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);

    let proof = host_owned
        .terminate_and_prove()
        .expect("host retry cleanup proof");
    assert!(proof.root_reaped);
    assert!(proof.descendants_terminated);
}

#[cfg(windows)]
#[test]
fn cleanup_proof_failure_retains_the_ownership_handle_for_retry() {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/S", "/C", "ping.exe -n 30 127.0.0.1 >nul"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    let root_pid = session.id();
    session.inject_cleanup_failure_for_test();

    let failure = session
        .terminate_and_prove()
        .expect_err("injected proof failure");
    assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);
    assert_eq!(session.id(), root_pid);

    let proof = session.terminate_and_prove().expect("retry cleanup proof");
    assert_eq!(proof.root_pid, root_pid);
    assert!(proof.root_reaped);
    assert!(proof.descendants_terminated);
}

#[cfg(windows)]
#[test]
fn monitor_root_exit_retries_cleanup_after_a_proof_race() {
    let mut command = Command::new("cmd.exe");
    command
        .args(["/D", "/S", "/C", "exit /B 17"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    let root_pid = session.id();
    while session.try_wait().expect("root status").is_none() {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    session.inject_cleanup_failure_for_test();

    let failure = session
        .monitor_root_exit()
        .expect_err("injected monitor proof failure");
    assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Injected);
    assert_eq!(session.id(), root_pid);

    let observed = session
        .monitor_root_exit()
        .expect("monitor retry")
        .expect("root exit");
    assert_eq!(session.id(), root_pid);
    assert!(observed.code().is_some());
}

#[cfg(windows)]
#[test]
fn root_exit_with_job_termination_failure_reaps_job_owned_descendant() {
    let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    wait_for_root_exit(&session);
    session.inject_job_termination_failure_for_test();

    let observed = session
        .monitor_root_exit()
        .expect("fallback cleanup proof")
        .expect("root exit");

    assert_eq!(observed.code(), Some(17));
    assert_eq!(session.active_processes_for_test().expect("job query"), 0);
}

#[cfg(windows)]
#[test]
fn root_still_alive_with_job_termination_failure_reaps_root_and_descendant() {
    let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','192.0.2.1' -WindowStyle Hidden; Start-Sleep -Seconds 30",
        );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    wait_for_active_processes(&session, 2);
    session.inject_job_termination_failure_for_test();

    let proof = session
        .terminate_and_prove()
        .expect("fallback cleanup proof");

    assert!(proof.root_reaped);
    assert!(proof.descendants_terminated);
    assert_eq!(session.active_processes_for_test().expect("job query"), 0);
}

#[cfg(windows)]
#[test]
fn job_query_failure_retains_session_for_retry_after_root_exit() {
    let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    let root_pid = session.id();
    wait_for_root_exit(&session);
    session.inject_job_termination_failure_for_test();
    session.inject_job_process_query_failure_for_test();

    let failure = session
        .monitor_root_exit()
        .expect_err("query failure must not claim cleanup");
    assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Descendants);
    assert_eq!(session.id(), root_pid);
    assert!(session
        .active_processes_for_test()
        .expect("job query")
        .ge(&1));

    let observed = session
        .monitor_root_exit()
        .expect("retry cleanup proof")
        .expect("root exit");
    assert_eq!(observed.code(), Some(17));
    assert_eq!(session.active_processes_for_test().expect("job query"), 0);
}

#[cfg(windows)]
#[test]
fn partial_descendant_termination_retains_session_and_retry_proves_cleanup() {
    let mut command = powershell_command(
            "$p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; $p = Start-Process ping.exe -ArgumentList '-n','30','127.0.0.1' -WindowStyle Hidden; exit 17",
        );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    wait_for_root_exit(&session);
    wait_for_active_processes(&session, 2);
    session.inject_job_termination_failure_for_test();
    session.inject_process_termination_failure_after_first_for_test();

    let failure = session
        .monitor_root_exit()
        .expect_err("partial kill must not claim cleanup");
    assert_eq!(failure.kind(), RuntimeCleanupErrorKind::Descendants);
    assert!(session.active_processes_for_test().expect("job query") >= 1);

    let observed = session
        .monitor_root_exit()
        .expect("retry cleanup proof")
        .expect("root exit");
    assert_eq!(observed.code(), Some(17));
    assert_eq!(session.active_processes_for_test().expect("job query"), 0);
}

#[test]
fn reused_pid_requires_the_same_creation_identity() {
    let original = OwnedProcessIdentity {
        pid: 4242,
        creation_time: 100,
    };
    let reused = OwnedProcessIdentity {
        pid: 4242,
        creation_time: 101,
    };
    assert!(!same_process_identity(original, reused));
    assert!(same_process_identity(original, original));
}

#[test]
fn process_list_count_inconsistency_at_capacity_fails_closed() {
    const MAX_CAPACITY: usize = 16_384;
    assert_eq!(
        next_process_list_capacity(16, 17, 17, MAX_CAPACITY).expect("capacity grows"),
        Some(32)
    );
    assert!(
        next_process_list_capacity(MAX_CAPACITY, MAX_CAPACITY + 1, 1, MAX_CAPACITY).is_err(),
        "a successful inconsistent count at the maximum must terminate enumeration"
    );
    assert!(
        next_process_list_capacity(MAX_CAPACITY, MAX_CAPACITY, MAX_CAPACITY + 1, MAX_CAPACITY)
            .is_err(),
        "an assigned count beyond the maximum must fail closed"
    );
}

#[test]
fn terminated_observation_requires_exact_identity_and_terminal_proof() {
    let expected = OwnedProcessIdentity {
        pid: 4242,
        creation_time: 100,
    };

    assert!(classify_terminated_observation(expected, expected, 0, Ok(17)).is_ok());
    assert!(classify_terminated_observation(expected, expected, 0, Err("query".into())).is_err());
    assert!(classify_terminated_observation(expected, expected, 0x0000_0102, Ok(17)).is_err());
    assert!(classify_terminated_observation(expected, expected, 0xffff_ffff, Ok(17)).is_err());
    assert!(classify_terminated_observation(expected, expected, 0xdead_beef, Ok(17)).is_err());
    assert!(classify_terminated_observation(expected, expected, 0, Ok(259)).is_err());
    assert!(classify_terminated_observation(
        expected,
        OwnedProcessIdentity {
            pid: expected.pid,
            creation_time: expected.creation_time + 1,
        },
        0,
        Ok(17),
    )
    .is_err());
}

#[cfg(windows)]
#[test]
fn short_lived_child_access_denied_is_classified_from_its_signaled_handle() {
    let mut child = Command::new("cmd.exe");
    child
        .args(["/D", "/S", "/C", "exit /B 17"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = child.spawn().expect("short-lived child");
    let pid = child.id();
    while child.try_wait().expect("child status").is_none() {
        std::thread::yield_now();
    }

    let handle = open_process_for_termination(pid).expect("retained process handle");
    let expected = process_identity_from_handle(handle.raw(), pid).expect("child identity");
    let observed = process_identity_from_handle(handle.raw(), pid).expect("handle identity");
    assert_eq!(expected, observed);
    assert_eq!(unsafe { TerminateProcess(handle.raw(), 1) }, 0);
    assert_eq!(unsafe { GetLastError() }, ERROR_ACCESS_DENIED);
    classify_terminated_process(handle.raw(), expected, observed)
        .expect("already-exited process proof");
    child.wait().expect("reap child");
}

#[cfg(windows)]
#[test]
fn short_lived_root_exit_cleanup_stress_is_sequential() {
    for _ in 0..100 {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/S", "/C", "exit /B 17"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
        wait_for_root_exit(&session);
        session.inject_job_termination_failure_for_test();

        let observed = session
            .monitor_root_exit()
            .expect("cleanup proof")
            .expect("root exit");
        assert_eq!(observed.code(), Some(17));
        assert_eq!(session.active_processes_for_test().expect("job query"), 0);
    }
}

#[cfg(windows)]
#[test]
fn missing_descendant_snapshot_requires_terminal_proof() {
    let mut command = powershell_command(
            "$p = Start-Process cmd.exe -ArgumentList '/D','/S','/C','ping.exe -n 3 127.0.0.1' -WindowStyle Hidden; Wait-Process -Id $p.Id; exit 17",
        );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let session = OwnedRuntimeSession::spawn(&mut command).expect("owned session");
    wait_for_active_processes(&session, 2);
    session.inject_stale_descendant_snapshot_for_test();
    wait_for_root_exit(&session);
    session.inject_job_termination_failure_for_test();

    let observed = session
        .monitor_root_exit()
        .expect("cleanup proof")
        .expect("root exit");
    assert_eq!(observed.code(), Some(17));
    assert_eq!(session.active_processes_for_test().expect("job query"), 0);
}

#[cfg(windows)]
fn wait_for_root_exit(session: &OwnedRuntimeSession) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while session.try_wait().expect("root status").is_none() && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(session.try_wait().expect("root status").is_some());
}

#[cfg(windows)]
fn powershell_command(script: &str) -> Command {
    let executable = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .expect("SystemRoot")
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let mut command = Command::new(executable);
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    command
}

#[cfg(windows)]
fn wait_for_active_processes(session: &OwnedRuntimeSession, minimum: u32) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while session
        .active_processes_for_test()
        .expect("job process query")
        < minimum
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(
        session
            .active_processes_for_test()
            .expect("job process query")
            >= minimum
    );
}
