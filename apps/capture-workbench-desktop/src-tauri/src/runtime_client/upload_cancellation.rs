use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant},
};

use super::validation::validate_client_request_id;

pub(super) const UPLOAD_CANCELLED: &str = "Upload was cancelled.";
/// The start and cancel commands run concurrently, so a cancellation can reach
/// the registry before its upload begins. It waits this long to be claimed.
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const PENDING_LIMIT: usize = 64;

#[derive(Default)]
struct Entries {
    active: HashMap<String, Arc<AtomicBool>>,
    /// Cancellations whose upload has not begun yet, by arrival time.
    pending: HashMap<String, Duration>,
}

pub(crate) struct UploadCancellations {
    entries: Mutex<Entries>,
    clock: Box<dyn Fn() -> Duration + Send + Sync>,
}

impl Default for UploadCancellations {
    fn default() -> Self {
        let start = Instant::now();
        Self {
            entries: Mutex::new(Entries::default()),
            clock: Box::new(move || start.elapsed()),
        }
    }
}

pub(crate) struct Upload {
    registry: Arc<UploadCancellations>,
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl UploadCancellations {
    fn lock(&self) -> Result<MutexGuard<'_, Entries>, String> {
        self.entries
            .lock()
            .map_err(|_| "Upload cancellation is unavailable.".into())
    }

    fn prune(&self, entries: &mut Entries) {
        let now = (self.clock)();
        entries
            .pending
            .retain(|_, arrived| now.saturating_sub(*arrived) < PENDING_TTL);
    }

    pub(crate) fn begin(self: &Arc<Self>, id: &str) -> Result<Upload, String> {
        validate_client_request_id(id)?;
        let mut entries = self.lock()?;
        self.prune(&mut entries);
        if entries.active.contains_key(id) {
            return Err("Upload request is already active.".into());
        }
        let cancelled = Arc::new(AtomicBool::new(entries.pending.remove(id).is_some()));
        entries
            .active
            .insert(id.to_string(), Arc::clone(&cancelled));
        Ok(Upload {
            registry: Arc::clone(self),
            id: id.to_string(),
            cancelled,
        })
    }

    pub(crate) fn request(&self, id: &str) -> Result<(), String> {
        validate_client_request_id(id)?;
        let mut entries = self.lock()?;
        if let Some(cancelled) = entries.active.get(id) {
            cancelled.store(true, Ordering::Release);
            return Ok(());
        }
        // The upload may not have begun yet, or may have just ended; a pending
        // entry of an ended upload is never claimed and expires.
        self.prune(&mut entries);
        if entries.pending.len() >= PENDING_LIMIT {
            if let Some(oldest) = entries
                .pending
                .iter()
                .min_by_key(|(_, arrived)| **arrived)
                .map(|(key, _)| key.clone())
            {
                entries.pending.remove(&oldest);
            }
        }
        let now = (self.clock)();
        entries.pending.insert(id.to_string(), now);
        Ok(())
    }
}

impl Upload {
    pub(super) fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(UPLOAD_CANCELLED.into());
        }
        Ok(())
    }

    /// A request that failed after the user cancelled reports the cancellation:
    /// retries of a transient failure can outlast the cancel request.
    pub(super) fn outcome(&self, error: String) -> String {
        self.check().err().unwrap_or(error)
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        // Even a poisoned registry must release ended uploads.
        let mut entries = match self.registry.entries.lock() {
            Ok(entries) => entries,
            Err(error) => error.into_inner(),
        };
        entries.active.remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn registry_with_clock() -> (Arc<UploadCancellations>, Arc<AtomicU64>) {
        let seconds = Arc::new(AtomicU64::new(0));
        let clock = Arc::clone(&seconds);
        let registry = UploadCancellations {
            entries: Mutex::new(Entries::default()),
            clock: Box::new(move || Duration::from_secs(clock.load(Ordering::SeqCst))),
        };
        (Arc::new(registry), seconds)
    }

    #[test]
    fn a_cancellation_that_arrives_before_its_upload_begins_is_claimed() {
        let registry = Arc::new(UploadCancellations::default());
        registry.request("early-request").expect("early cancel");
        let upload = registry.begin("early-request").expect("upload");
        assert_eq!(upload.check().unwrap_err(), UPLOAD_CANCELLED);
        assert!(registry.lock().expect("registry").pending.is_empty());
        drop(upload);
        // Claimed once: a later upload with the same id starts uncancelled.
        registry
            .begin("early-request")
            .expect("upload")
            .check()
            .expect("not cancelled");
    }

    #[test]
    fn unclaimed_cancellations_expire_and_stay_bounded() {
        let (registry, seconds) = registry_with_clock();
        registry.request("ended-upload").expect("late cancel");
        seconds.store(PENDING_TTL.as_secs(), Ordering::SeqCst);
        registry
            .begin("ended-upload")
            .expect("upload")
            .check()
            .expect("an expired cancellation is not applied");
        assert!(registry.lock().expect("registry").pending.is_empty());

        for index in 0..=PENDING_LIMIT {
            seconds.store(PENDING_TTL.as_secs() + index as u64, Ordering::SeqCst);
            registry
                .request(&format!("pending-{index}"))
                .expect("cancel");
        }
        let entries = registry.lock().expect("registry");
        assert_eq!(entries.pending.len(), PENDING_LIMIT);
        assert!(!entries.pending.contains_key("pending-0"), "oldest dropped");
    }

    #[test]
    fn invalid_ids_are_rejected_without_retaining_entries() {
        let registry = UploadCancellations::default();
        assert!(registry.request("invalid/id").is_err());
        let entries = registry.lock().expect("registry");
        assert!(entries.pending.is_empty() && entries.active.is_empty());
    }

    #[test]
    fn guards_remove_entries_on_success_failure_and_cancellation() {
        let registry = Arc::new(UploadCancellations::default());
        for outcome in ["success", "failure", "cancelled"] {
            let result: Result<(), String> = (|| {
                let upload = registry.begin(outcome)?;
                if outcome == "cancelled" {
                    registry.request(outcome)?;
                }
                upload.check()?;
                if outcome == "failure" {
                    return Err("failure".into());
                }
                Ok(())
            })();
            assert_eq!(result.is_ok(), outcome == "success");
            let entries = registry.lock().expect("registry");
            assert!(entries.active.is_empty() && entries.pending.is_empty());
        }
    }

    #[test]
    fn a_failure_after_cancellation_reports_the_cancellation() {
        let registry = Arc::new(UploadCancellations::default());
        let upload = registry.begin("retrying-upload").expect("upload");
        assert_eq!(upload.outcome("HTTP 503".into()), "HTTP 503");
        registry.request("retrying-upload").expect("cancel");
        assert_eq!(upload.outcome("HTTP 503".into()), UPLOAD_CANCELLED);
    }
}
