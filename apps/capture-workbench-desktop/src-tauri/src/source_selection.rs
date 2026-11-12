pub(crate) mod inspect;
use crate::{contracts::*, random_id::random_id};
use inspect::{inspect_source, OpenedSource};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
const UNAVAILABLE: &str = "Selected source is no longer available. Choose it again.";
const TTL: Duration = Duration::from_secs(30 * 60);
struct Entry {
    owner: String,
    expires: Duration,
    source: OpenedSource,
}
#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    channels: HashMap<String, Channel<LibrarySourceSelectionBatch>>,
    dialogs: HashSet<String>,
    destroyed: HashSet<String>,
}
pub(crate) struct SourceSelections {
    registry: Mutex<Registry>,
    clock: Box<dyn Fn() -> Duration + Send + Sync>,
}
impl Default for SourceSelections {
    fn default() -> Self {
        let start = Instant::now();
        Self {
            registry: Mutex::new(Registry::default()),
            clock: Box::new(move || start.elapsed()),
        }
    }
}
impl SourceSelections {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Registry>, String> {
        self.registry
            .lock()
            .map_err(|_| "Source selection is unavailable.".into())
    }
    fn prune(&self, registry: &mut Registry) {
        let now = (self.clock)();
        registry.entries.retain(|_, entry| entry.expires > now);
    }
    pub(crate) fn take(&self, owner: &str, token: &str) -> Result<OpenedSource, String> {
        let mut registry = self.lock()?;
        self.prune(&mut registry);
        if token.len() != 32
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !registry
                .entries
                .get(token)
                .is_some_and(|entry| entry.owner == owner)
        {
            return Err(UNAVAILABLE.into());
        }
        Ok(registry.entries.remove(token).ok_or(UNAVAILABLE)?.source)
    }
    pub(crate) fn discard(&self, owner: &str, tokens: &[String]) -> Result<(), String> {
        let mut registry = self.lock()?;
        self.prune(&mut registry);
        for token in tokens {
            if registry
                .entries
                .get(token)
                .is_some_and(|entry| entry.owner == owner)
            {
                registry.entries.remove(token);
            }
        }
        Ok(())
    }
    pub(crate) fn import(
        &self,
        owner: &str,
        request: LibraryImportSelectionRequest,
        library: &crate::library::LibraryStore,
    ) -> Result<LibraryDocumentSummary, String> {
        // A rejected options request must leave the owner's selection usable.
        if let Some(options) = &request.capture_options {
            crate::library::validation::validate_capture_options(options)?;
        }
        let source = self.take(owner, &request.selection_token)?;
        library
            .import_opened(source, request.capture_options)
            .map_err(|error| {
                if error == "Selected source changed during import." {
                    error
                } else {
                    "Selected source could not be imported.".into()
                }
            })
    }
    pub(crate) fn watch(
        &self,
        owner: &str,
        channel: Channel<LibrarySourceSelectionBatch>,
    ) -> Result<(), String> {
        let mut registry = self.lock()?;
        self.prune(&mut registry);
        if registry.destroyed.contains(owner) {
            return Err(UNAVAILABLE.into());
        }
        registry.channels.insert(owner.into(), channel);
        Ok(())
    }
    pub(crate) fn destroy(&self, owner: &str) {
        if let Ok(mut registry) = self.lock() {
            self.prune(&mut registry);
            registry.entries.retain(|_, entry| entry.owner != owner);
            registry.channels.remove(owner);
            registry.dialogs.remove(owner);
            registry.destroyed.insert(owner.into());
        }
    }
    pub(crate) fn begin_dialog(self: &Arc<Self>, owner: &str) -> Result<DialogGuard, String> {
        let mut registry = self.lock()?;
        self.prune(&mut registry);
        if registry.destroyed.contains(owner) {
            return Err(UNAVAILABLE.into());
        }
        if !registry.dialogs.is_empty() {
            return Err("A file dialog is already open.".into());
        }
        registry.dialogs.insert(owner.into());
        Ok(DialogGuard {
            selections: Arc::clone(self),
            owner: owner.into(),
        })
    }
    pub(crate) fn inspect_batch(
        &self,
        owner: &str,
        paths: Vec<PathBuf>,
        kind: SourceSelectionKind,
    ) -> Result<LibrarySourceSelectionBatch, String> {
        let mut batch = LibrarySourceSelectionBatch::default();
        for path in paths {
            match inspect_source(&path, kind) {
                Err(reason) => batch.rejected.push(reason),
                Ok(source) => {
                    let mut registry = self.lock()?;
                    self.prune(&mut registry);
                    if registry.destroyed.contains(owner) {
                        return Err(UNAVAILABLE.into());
                    }
                    if registry.entries.len() >= 64 {
                        batch.rejected.push(SourceRejectionReason::LimitReached);
                        continue;
                    }
                    let token = loop {
                        let token = random_id()?;
                        if !registry.entries.contains_key(&token) {
                            break token;
                        }
                    };
                    batch.selections.push(LibrarySourceSelection {
                        selection_token: token.clone(),
                        file_name: source.file_name.clone(),
                        byte_length: source.byte_length,
                        media_type: source.media_type.clone(),
                    });
                    registry.entries.insert(
                        token,
                        Entry {
                            owner: owner.into(),
                            expires: (self.clock)() + TTL,
                            source,
                        },
                    );
                }
            }
        }
        // Even an empty or wholly rejected batch expires old handles.
        let mut registry = self.lock()?;
        self.prune(&mut registry);
        Ok(batch)
    }
    fn process_drop(&self, owner: &str, paths: Vec<PathBuf>) -> Result<(), String> {
        let channel = {
            let mut registry = self.lock()?;
            self.prune(&mut registry);
            registry.channels.get(owner).cloned()
        };
        let Some(channel) = channel else {
            return Ok(());
        };
        let batch = self.inspect_batch(owner, paths, SourceSelectionKind::All)?;
        let tokens: Vec<_> = batch
            .selections
            .iter()
            .map(|selection| selection.selection_token.clone())
            .collect();
        if channel.send(batch).is_err() {
            self.discard(owner, &tokens)?;
        }
        Ok(())
    }

    pub(crate) fn drop_paths(self: &Arc<Self>, owner: String, paths: Vec<PathBuf>) {
        // Even expiry (which closes handles) belongs on the blocking worker.
        // With no subscriber, process_drop returns before inspecting any path.
        let selections = Arc::clone(self);
        tauri::async_runtime::spawn_blocking(move || {
            let _ = selections.process_drop(&owner, paths);
        });
    }
}
pub(crate) struct DialogGuard {
    selections: Arc<SourceSelections>,
    owner: String,
}
impl Drop for DialogGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.selections.lock() {
            self.selections.prune(&mut registry);
            registry.dialogs.remove(&self.owner);
        }
    }
}
#[cfg(test)]
mod tests;
