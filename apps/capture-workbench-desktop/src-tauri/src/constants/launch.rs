pub(crate) const CHILD_ENVIRONMENT_ALLOWLIST: &[&str] = &[
    "APPDATA",
    "COMSPEC",
    // Lets the isolated GPU workers see a host CUDA toolkit; their PyTorch
    // wheels also bundle the CUDA runtime they need.
    "CUDA_PATH",
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
