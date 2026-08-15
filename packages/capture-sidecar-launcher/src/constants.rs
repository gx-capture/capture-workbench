use std::time::Duration;

pub(crate) const LOOPBACK_HOST: &str = "127.0.0.1";
pub(crate) const HEALTH_PATH: &str = "/v2/health/ready";
pub(crate) const MAX_HEALTH_RESPONSE_BYTES: u64 = 64 * 1024;
pub(crate) const READY_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const READY_POLL_INTERVAL: Duration = Duration::from_millis(100);
pub(crate) const MAX_LAUNCH_ATTEMPTS: usize = 3;
pub(crate) const TOTAL_LAUNCH_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const RETRY_POLL_INTERVAL: Duration = Duration::from_millis(25);
pub(crate) const RETRY_DELAY: Duration = Duration::from_millis(100);
pub(crate) const EXPECTED_MANIFEST_VERSION: &str = "1";
pub(crate) const MAX_RUNTIME_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
