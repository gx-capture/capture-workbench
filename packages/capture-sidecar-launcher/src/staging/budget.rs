use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

#[cfg(test)]
use std::cell::Cell;

use super::failure::StagingFailureKind;

#[cfg(test)]
thread_local! {
    static CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR: Cell<bool> = const { Cell::new(false) };
    static CANCEL_MATERIALIZE_AFTER_MARKER: Cell<bool> = const { Cell::new(false) };
    static CANCEL_AFTER_READY_CAS: Cell<bool> = const { Cell::new(false) };
    static CANCEL_AFTER_LAUNCHING_CAS: Cell<bool> = const { Cell::new(false) };
}

/// The legacy staging entrypoints use an unbounded budget, while activation
/// passes one absolute deadline and cancellation flag through this private
/// seam.  Keeping the gate here prevents a budgeted caller from accidentally
/// restarting a per-operation timeout.
pub(super) struct StagingBudget {
    deadline: Option<Instant>,
    cancellation: Option<Arc<AtomicBool>>,
}

impl StagingBudget {
    pub(super) fn unbounded() -> Self {
        Self {
            deadline: None,
            cancellation: None,
        }
    }

    pub(super) fn bounded(deadline: Instant, cancellation: Arc<AtomicBool>) -> Self {
        Self {
            deadline: Some(deadline),
            cancellation: Some(cancellation),
        }
    }

    pub(super) fn check(&self) -> Result<(), StagingFailureKind> {
        if self
            .cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
        {
            return Err(StagingFailureKind::Cancelled);
        }
        if self
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err(StagingFailureKind::Deadline);
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn cancel_after_group_mkdir_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    pub(super) fn cancel_after_group_mkdir_if_requested(&self) {}

    #[cfg(test)]
    pub(super) fn cancel_after_marker_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_MATERIALIZE_AFTER_MARKER.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    pub(super) fn cancel_after_marker_if_requested(&self) {}

    #[cfg(test)]
    pub(super) fn cancel_after_ready_cas_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_AFTER_READY_CAS.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    pub(super) fn cancel_after_ready_cas_if_requested(&self) {}

    #[cfg(test)]
    pub(super) fn cancel_after_launching_cas_if_requested(&self) {
        if self.deadline.is_none() {
            return;
        }
        if CANCEL_AFTER_LAUNCHING_CAS.with(|fault| fault.replace(false)) {
            if let Some(cancellation) = &self.cancellation {
                cancellation.store(true, std::sync::atomic::Ordering::Release);
            }
        }
    }

    #[cfg(not(test))]
    pub(super) fn cancel_after_launching_cas_if_requested(&self) {}
}

#[cfg(test)]
pub(crate) fn cancel_materialize_after_group_mkdir_for_test() {
    CANCEL_MATERIALIZE_AFTER_GROUP_MKDIR.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_materialize_after_marker_for_test() {
    CANCEL_MATERIALIZE_AFTER_MARKER.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_after_ready_cas_for_test() {
    CANCEL_AFTER_READY_CAS.with(|fault| fault.set(true));
}

#[cfg(test)]
pub(crate) fn cancel_after_launching_cas_for_test() {
    CANCEL_AFTER_LAUNCHING_CAS.with(|fault| fault.set(true));
}
