use std::time::Duration;

pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MAX_LAUNCH_ATTEMPTS: usize = 3;
pub(crate) const TOTAL_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const RETRY_POLL_INTERVAL: Duration = Duration::from_millis(25);
pub(crate) const RETRY_DELAY: Duration = Duration::from_millis(100);
pub(crate) const CHILD_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "APPDATA",
    "COMSPEC",
    "LOCALAPPDATA",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "PATH",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PROGRAMDATA",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "WINDIR",
];
