use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;

use crate::{
    library::LibraryStore, resources::RuntimeExecutablePaths, runtime_client::UploadCancellations,
    source_selection::SourceSelections, state::DesktopState,
};

pub(crate) const DEV_HOST_OWNER: &str = "main";

pub(crate) struct HostContext {
    pub(crate) state: DesktopState,
    pub(crate) library: Arc<LibraryStore>,
    pub(crate) selections: Arc<SourceSelections>,
    pub(crate) uploads: Arc<UploadCancellations>,
    pub(crate) assets: Option<RuntimeExecutablePaths>,
    queued_selections: Mutex<VecDeque<Vec<PathBuf>>>,
    pub(crate) owner: String,
}

impl HostContext {
    pub(crate) fn new(
        state: DesktopState,
        library: Arc<LibraryStore>,
        assets: Option<RuntimeExecutablePaths>,
    ) -> Self {
        Self {
            state,
            library,
            selections: Arc::new(SourceSelections::default()),
            uploads: Arc::new(UploadCancellations::default()),
            assets,
            queued_selections: Mutex::new(VecDeque::new()),
            owner: DEV_HOST_OWNER.to_owned(),
        }
    }

    pub(crate) fn push_selection(&self, paths: Vec<PathBuf>) -> Result<(), String> {
        let mut queue = self
            .queued_selections
            .lock()
            .map_err(|_| "Selection queue is unavailable.".to_string())?;
        queue.push_back(paths);
        Ok(())
    }

    pub(crate) fn pop_selection(&self) -> Result<Vec<PathBuf>, String> {
        let mut queue = self
            .queued_selections
            .lock()
            .map_err(|_| "Selection queue is unavailable.".to_string())?;
        Ok(queue.pop_front().unwrap_or_default())
    }
}

#[derive(Debug)]
pub(crate) enum HostResponse {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum HostError {
    UnknownCommand,
    InvalidArgs(String),
    CommandFailed(String),
}

#[cfg(test)]
pub(crate) struct CommandGroups {
    pub(crate) served: &'static [&'static str],
    pub(crate) replaced: &'static [&'static str],
    pub(crate) not_served: &'static [&'static str],
}

macro_rules! build_dispatch_table {
    (
        extra: [],
        served: [$($served:ident),* $(,)?],
        replaced: [$($replaced:ident),* $(,)?],
        not_served: [$($not_served:ident),* $(,)?],
    ) => {
        pub(crate) fn dispatch(
            command: &str,
            args: Value,
            context: &HostContext,
        ) -> Result<HostResponse, HostError> {
            match command {
                $(stringify!($served) => handlers::$served(args, context),)*
                $(stringify!($replaced) => handlers::$replaced(args, context),)*
                $(stringify!($not_served) => {
                    let _ = (args, context);
                    Err(HostError::UnknownCommand)
                })*
                _ => Err(HostError::UnknownCommand),
            }
        }

        pub(crate) fn is_served_command(command: &str) -> bool {
            match command {
                $(stringify!($served) => true,)*
                $(stringify!($replaced) => true,)*
                _ => false,
            }
        }

        #[cfg(test)]
        pub(crate) const COMMAND_GROUPS: CommandGroups = CommandGroups {
            served: &[$(stringify!($served)),*],
            replaced: &[$(stringify!($replaced)),*],
            not_served: &[$(stringify!($not_served)),*],
        };
    };
}

macro_rules! define_feature_gated_commands {
    (
        acceptance_harness: [$($acceptance:ident),* $(,)?],
    ) => {
        pub(super) fn is_feature_gated_command(command: &str) -> bool {
            matches!(command, $(stringify!($acceptance))|*)
        }

        #[cfg(test)]
        pub(crate) const FEATURE_GATED_GROUPS: &[&[&str]] = &[
            &[$(stringify!($acceptance)),*],
        ];
    };
}

for_each_feature_gated_desktop_command!(define_feature_gated_commands);
for_each_desktop_command!(build_dispatch_table);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestArgs<T> {
    request: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputArgs<T> {
    input: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateArgs<T> {
    update: T,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetPreferGpuArgs {
    prefer_gpu: bool,
}

fn parse_args<T: DeserializeOwned>(args: Value) -> Result<T, HostError> {
    serde_json::from_value(args)
        .map_err(|error| HostError::InvalidArgs(format!("Invalid command arguments: {error}")))
}

fn json_ok<T: Serialize>(value: T) -> Result<HostResponse, HostError> {
    serde_json::to_value(value)
        .map(HostResponse::Json)
        .map_err(|error| HostError::CommandFailed(format!("Response cannot be encoded: {error}")))
}

fn json_result<T: Serialize>(result: Result<T, String>) -> Result<HostResponse, HostError> {
    match result {
        Ok(value) => json_ok(value),
        Err(error) => Err(HostError::CommandFailed(error)),
    }
}

mod handlers {
    use serde_json::Value;

    use super::{
        json_ok, json_result, parse_args, EmptyArgs, HostContext, HostError, HostResponse,
        InputArgs, RequestArgs, SetPreferGpuArgs, UpdateArgs,
    };
    use crate::{
        contracts::{
            LibraryCaptureUpdate, LibraryDiscardSelectionsRequest, LibraryDocumentRequest,
            LibraryExportRequest, LibraryImportSelectionRequest, LibraryListRequest,
            LibrarySaveEditsRequest, LibrarySelectSourcesRequest, RuntimeCancelUploadInput,
            RuntimeCreateCaptureInput, RuntimeIdInput, RuntimeInstallationStartInput,
            RuntimeRequirementInput, RuntimeStreamingCaptureInput, RuntimeStreamingEventsInput,
            StructuringModelInstallationStartInput,
        },
        host_api,
    };

    pub(super) fn desktop_runtime_status(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_ok(host_api::desktop_runtime_status(&context.state))
    }

    pub(super) fn desktop_speech_gpu_status(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_ok(host_api::desktop_speech_gpu_status(&context.state))
    }

    pub(super) fn desktop_set_speech_prefer_gpu(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let SetPreferGpuArgs { prefer_gpu } = parse_args(args)?;
        json_result(host_api::desktop_set_speech_prefer_gpu(
            &context.state,
            context.assets.as_ref(),
            prefer_gpu,
        ))
    }

    pub(super) fn runtime_ready(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_result(host_api::runtime_ready(&context.state))
    }

    pub(super) fn library_select_sources(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibrarySelectSourcesRequest> = parse_args(args)?;
        let _guard = context
            .selections
            .begin_dialog(&context.owner)
            .map_err(HostError::CommandFailed)?;
        let paths = context.pop_selection().map_err(HostError::CommandFailed)?;
        json_result(host_api::library_inspect_selected_sources(
            &context.selections,
            &context.owner,
            paths,
            request.kind,
        ))
    }

    pub(super) fn library_watch_native_sources(
        args: Value,
        _context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        if !args.is_object() {
            return Err(HostError::InvalidArgs(
                "Invalid command arguments: expected an object.".into(),
            ));
        }
        json_ok(())
    }

    pub(super) fn library_import_selection(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryImportSelectionRequest> = parse_args(args)?;
        json_result(host_api::library_import_selection(
            &context.owner,
            &context.selections,
            &context.library,
            request,
        ))
    }

    pub(super) fn library_discard_selections(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryDiscardSelectionsRequest> =
            parse_args(args)?;
        json_result(host_api::library_discard_selections(
            &context.owner,
            &context.selections,
            request,
        ))
    }

    pub(super) fn library_update_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let UpdateArgs { update }: UpdateArgs<LibraryCaptureUpdate> = parse_args(args)?;
        json_result(host_api::library_update_capture(&context.library, update))
    }

    pub(super) fn library_list(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryListRequest> = parse_args(args)?;
        json_result(host_api::library_list(&context.library, request))
    }

    pub(super) fn library_get(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryDocumentRequest> = parse_args(args)?;
        json_result(host_api::library_get(&context.library, request))
    }

    pub(super) fn library_save_edits(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibrarySaveEditsRequest> = parse_args(args)?;
        json_result(host_api::library_save_edits(&context.library, request))
    }

    pub(super) fn library_export(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryExportRequest> = parse_args(args)?;
        json_result(host_api::library_export(&context.library, request))
    }

    pub(super) fn library_source_bytes(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryDocumentRequest> = parse_args(args)?;
        host_api::library_source_bytes(&context.library, request)
            .map(HostResponse::Bytes)
            .map_err(HostError::CommandFailed)
    }

    pub(super) fn library_delete(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let RequestArgs { request }: RequestArgs<LibraryDocumentRequest> = parse_args(args)?;
        json_result(host_api::library_delete(&context.library, request))
    }

    pub(super) fn runtime_requirements(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_result(host_api::runtime_requirements(&context.state))
    }

    pub(super) fn runtime_start_installation(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeInstallationStartInput> = parse_args(args)?;
        json_result(host_api::runtime_start_installation(&context.state, input))
    }

    pub(super) fn runtime_list_installations(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_result(host_api::runtime_list_installations(&context.state))
    }

    pub(super) fn runtime_get_installation(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_installation(&context.state, input))
    }

    pub(super) fn runtime_cancel_installation(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_cancel_installation(&context.state, input))
    }

    pub(super) fn runtime_uninstall_requirement(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeRequirementInput> = parse_args(args)?;
        json_result(host_api::runtime_uninstall_requirement(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_structuring_model_options(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let EmptyArgs {} = parse_args(args)?;
        json_result(host_api::runtime_structuring_model_options(&context.state))
    }

    pub(super) fn runtime_start_structuring_model_installation(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<StructuringModelInstallationStartInput> =
            parse_args(args)?;
        json_result(host_api::runtime_start_structuring_model_installation(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_get_structuring_model_installation(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_structuring_model_installation(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_cancel_upload(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeCancelUploadInput> = parse_args(args)?;
        json_result(host_api::runtime_cancel_upload(&context.uploads, input))
    }

    pub(super) fn runtime_create_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeCreateCaptureInput> = parse_args(args)?;
        json_result(host_api::runtime_create_capture(
            &context.state,
            &context.library,
            &context.uploads,
            input,
        ))
    }

    pub(super) fn runtime_start_streaming_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeStreamingCaptureInput> = parse_args(args)?;
        json_result(host_api::runtime_start_streaming_capture(
            &context.state,
            &context.library,
            &context.uploads,
            input,
        ))
    }

    pub(super) fn runtime_get_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_capture(&context.state, input))
    }

    pub(super) fn runtime_get_streaming_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_streaming_capture(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_get_streaming_events(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeStreamingEventsInput> = parse_args(args)?;
        json_result(host_api::runtime_get_streaming_events(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_get_streaming_partial(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_streaming_partial(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_get_streaming_result(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_streaming_result(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_structure_streaming_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_structure_streaming_capture(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_cancel_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_cancel_capture(&context.state, input))
    }

    pub(super) fn runtime_cancel_streaming_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_cancel_streaming_capture(
            &context.state,
            input,
        ))
    }

    pub(super) fn runtime_get_raw(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_raw(&context.state, input))
    }

    pub(super) fn runtime_get_ocr(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_ocr(&context.state, input))
    }

    pub(super) fn runtime_get_result(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_get_result(&context.state, input))
    }

    pub(super) fn runtime_delete_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_delete_capture(&context.state, input))
    }

    pub(super) fn runtime_delete_streaming_capture(
        args: Value,
        context: &HostContext,
    ) -> Result<HostResponse, HostError> {
        let InputArgs { input }: InputArgs<RuntimeIdInput> = parse_args(args)?;
        json_result(host_api::runtime_delete_streaming_capture(
            &context.state,
            input,
        ))
    }
}
