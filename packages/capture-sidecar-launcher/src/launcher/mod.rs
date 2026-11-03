mod activation;
mod command;
mod launch;
mod loopback;
mod readiness;
mod spec;
mod token;

#[cfg(test)]
mod fixture;

pub use activation::{build_immutable_group_plan, GroupRootPlanInput};
pub use launch::{launch_sidecar, launch_sidecar_with_observer, LaunchOptions, LaunchedSidecar};
pub use loopback::{reserve_distinct_loopback_port, reserve_loopback_port};
pub use spec::SidecarLaunchSpec;
pub use token::generate_bearer_token;

pub(crate) use activation::FrozenActivationDescriptor;
