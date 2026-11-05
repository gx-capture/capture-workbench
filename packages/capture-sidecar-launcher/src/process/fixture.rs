use crate::journal_store::JournalStore;
#[cfg(all(test, windows))]
use std::{
    cell::Cell,
    sync::{
        atomic::AtomicBool,
        mpsc::{Receiver, SyncSender},
        Arc, Condvar, Mutex, OnceLock,
    },
};

#[cfg(all(test, windows))]
use crate::journal_store::ActivationBudget;

#[cfg(all(test, windows))]
use crate::prepare::ActivationCancelHandle;

#[cfg(all(test, windows))]
thread_local! {
    pub(crate) static CANCEL_AFTER_READY_HELPER: Cell<bool> = const { Cell::new(false) };
    pub(crate) static CANCEL_AFTER_RESUME_ALL: Cell<bool> = const { Cell::new(false) };
    pub(crate) static CANCEL_BEFORE_RESUME_ROOT: Cell<Option<usize>> = const { Cell::new(None) };
    pub(crate) static CANCEL_AFTER_RESUME_ROOT: Cell<Option<usize>> = const { Cell::new(None) };
    pub(crate) static EXPIRE_AFTER_SPAWN_BEFORE_ASSIGNMENT: Cell<bool> = const { Cell::new(false) };
}

/// The Windows activation-probe tests start real Job/child/listener groups.
/// Keep at most two HTTP fixture groups for the whole live native-fixture
/// lifetime; a permit is released only after native cleanup is proven.  This
/// keeps the full default-parallel suite from exhausting the host's
/// short-lived process and loopback resources while non-fixture tests remain
/// parallel.
#[cfg(all(test, windows))]
const HTTP_FIXTURE_CONCURRENCY_LIMIT: usize = 2;

#[cfg(all(test, windows))]
pub(crate) struct HttpFixtureLimiter {
    capacity: usize,
    available: Mutex<usize>,
    wake: Condvar,
}

#[cfg(all(test, windows))]
pub(crate) struct HttpFixturePermit {
    limiter: Arc<HttpFixtureLimiter>,
}

#[cfg(all(test, windows))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpFixturePermitError {
    Timeout,
    Poisoned,
}

#[cfg(all(test, windows))]
impl HttpFixtureLimiter {
    pub(crate) fn new(capacity: usize) -> Arc<Self> {
        assert!(capacity > 0, "fixture limiter capacity must be positive");
        Arc::new(Self {
            capacity,
            available: Mutex::new(capacity),
            wake: Condvar::new(),
        })
    }

    pub(crate) fn acquire(
        self: &Arc<Self>,
        timeout: std::time::Duration,
    ) -> Result<HttpFixturePermit, HttpFixturePermitError> {
        let deadline = std::time::Instant::now() + timeout;
        let mut available = self
            .available
            .lock()
            .map_err(|_| HttpFixturePermitError::Poisoned)?;
        while *available == 0 {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(HttpFixturePermitError::Timeout);
            }
            let (next_available, wait_result) = self
                .wake
                .wait_timeout(available, remaining)
                .map_err(|_| HttpFixturePermitError::Poisoned)?;
            available = next_available;
            if wait_result.timed_out() && *available == 0 {
                return Err(HttpFixturePermitError::Timeout);
            }
        }
        *available -= 1;
        drop(available);
        Ok(HttpFixturePermit {
            limiter: Arc::clone(self),
        })
    }

    pub(crate) fn acquire_available(
        self: &Arc<Self>,
    ) -> Result<HttpFixturePermit, HttpFixturePermitError> {
        let mut available = self
            .available
            .lock()
            .map_err(|_| HttpFixturePermitError::Poisoned)?;
        while *available == 0 {
            available = self
                .wake
                .wait(available)
                .map_err(|_| HttpFixturePermitError::Poisoned)?;
        }
        *available -= 1;
        drop(available);
        Ok(HttpFixturePermit {
            limiter: Arc::clone(self),
        })
    }
}

#[cfg(all(test, windows))]
impl Drop for HttpFixturePermit {
    fn drop(&mut self) {
        let mut available = self.limiter.available.lock().unwrap();
        *available = available.saturating_add(1).min(self.limiter.capacity);
        self.limiter.wake.notify_one();
    }
}

// Admission belongs outside the scenario clock. The guard retains an unused
// permit on early validation failure; native acquisition takes it exactly once.
#[cfg(all(test, windows))]
thread_local! {
    pub(crate) static SCHEDULED_FIXTURES: std::cell::RefCell<std::collections::HashMap<usize, HttpFixturePermit>> = std::cell::RefCell::new(std::collections::HashMap::new());
}

#[cfg(all(test, windows))]
pub(crate) struct ScheduledFixtureAdmission(usize);

#[cfg(all(test, windows))]
impl ScheduledFixtureAdmission {
    pub(crate) fn new(store: &Arc<JournalStore>, permit: HttpFixturePermit) -> Self {
        let key = Arc::as_ptr(store) as usize;
        SCHEDULED_FIXTURES.with(|pending| {
            assert!(
                pending.borrow_mut().insert(key, permit).is_none(),
                "duplicate fixture admission"
            );
        });
        Self(key)
    }

    pub(crate) fn take(&self) -> Option<HttpFixturePermit> {
        SCHEDULED_FIXTURES.with(|pending| pending.borrow_mut().remove(&self.0))
    }
}

#[cfg(all(test, windows))]
impl Drop for ScheduledFixtureAdmission {
    fn drop(&mut self) {
        self.take();
    }
}

#[cfg(all(test, windows))]
pub(crate) fn acquire_http_fixture_permit() -> Result<HttpFixturePermit, HttpFixturePermitError> {
    http_fixture_limiter().acquire_available()
}

#[cfg(all(test, windows))]
pub(crate) fn http_fixture_limiter() -> &'static Arc<HttpFixtureLimiter> {
    static LIMITER: OnceLock<Arc<HttpFixtureLimiter>> = OnceLock::new();
    LIMITER.get_or_init(|| HttpFixtureLimiter::new(HTTP_FIXTURE_CONCURRENCY_LIMIT))
}

#[cfg(all(test, windows))]
pub(crate) fn acquire_http_fixture_permit_with_budget(
    budget: &ActivationBudget,
) -> Result<HttpFixturePermit, HttpFixturePermitError> {
    let limiter = http_fixture_limiter();
    loop {
        if budget.check().is_err() {
            return Err(HttpFixturePermitError::Timeout);
        }
        let remaining = budget
            .deadline()
            .saturating_duration_since(std::time::Instant::now());
        let wait = remaining.min(std::time::Duration::from_millis(50));
        if wait.is_zero() {
            return Err(HttpFixturePermitError::Timeout);
        }
        match limiter.acquire(wait) {
            Ok(permit) => {
                if budget.check().is_ok() {
                    return Ok(permit);
                }
                return Err(HttpFixturePermitError::Timeout);
            }
            Err(HttpFixturePermitError::Timeout) => {}
            Err(HttpFixturePermitError::Poisoned) => return Err(HttpFixturePermitError::Poisoned),
        }
    }
}

#[cfg(all(test, windows))]
pub(crate) struct RunningAdmissionTestHook {
    pub(crate) reached: SyncSender<()>,
    pub(crate) acquired: Receiver<()>,
}

#[cfg(all(test, windows))]
pub(crate) struct ReadinessProbeTestHook {
    pub(crate) after_ordinal: usize,
    pub(crate) reached: Arc<AtomicBool>,
    pub(crate) cancel: ActivationCancelHandle,
}

#[cfg(all(test, windows))]
pub(crate) struct RunningCommitTestHook {
    pub(crate) reached: Arc<AtomicBool>,
    pub(crate) cancel: ActivationCancelHandle,
}

#[cfg(all(test, windows))]
pub(crate) struct ClosingAdmissionTestHook {
    pub(crate) reached: SyncSender<()>,
    pub(crate) acquired: Receiver<()>,
}

/// Private move-only authority after service readiness has been observed for
/// every resumed root and the exact Running CAS has been durably read back.
/// The native and staging owners remain together for the later lifecycle
/// slices; no public lease or terminal proof is created here.
#[cfg(windows)]
#[cfg(all(test, windows))]
pub(crate) fn inject_cancellation_after_ready_helper_for_test() {
    CANCEL_AFTER_READY_HELPER.with(|cancel| cancel.set(true));
}

#[cfg(all(test, windows))]
pub(crate) fn inject_cancellation_after_resume_all_for_test() {
    CANCEL_AFTER_RESUME_ALL.with(|cancel| cancel.set(true));
}

#[cfg(all(test, windows))]
pub(crate) fn expire_after_spawn_before_assignment_for_test() {
    EXPIRE_AFTER_SPAWN_BEFORE_ASSIGNMENT.with(|expire| expire.set(true));
}

#[cfg(all(test, windows))]
pub(crate) fn inject_cancellation_before_resume_root_for_test(index: usize) {
    CANCEL_BEFORE_RESUME_ROOT.with(|cancel_at| cancel_at.set(Some(index)));
}

#[cfg(all(test, windows))]
pub(crate) fn inject_cancellation_after_resume_root_for_test(index: usize) {
    CANCEL_AFTER_RESUME_ROOT.with(|cancel_at| cancel_at.set(Some(index)));
}
