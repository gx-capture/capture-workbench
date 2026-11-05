#[cfg(any(windows, test))]
pub(crate) mod handle;
#[cfg(windows)]
pub(crate) mod job;
pub(crate) mod tree;

#[cfg(any(windows, test))]
pub(crate) use handle::*;
#[cfg(windows)]
pub(crate) use job::*;
pub(crate) use tree::*;

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct OwnedProcessIdentity {
    pub(crate) pid: u32,
    pub(crate) creation_time: u64,
}

#[cfg(any(windows, test))]
pub(crate) fn same_process_identity(
    expected: OwnedProcessIdentity,
    observed: OwnedProcessIdentity,
) -> bool {
    expected.pid == observed.pid && expected.creation_time == observed.creation_time
}
