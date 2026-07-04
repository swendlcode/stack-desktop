use std::path::Path;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::core::{Indexer, Scanner};
use crate::db::{AssetRepository, PackRepository};
use crate::error::Result;
use crate::models::ReconcileReport;

pub struct Reconciler;

impl Reconciler {
    pub async fn run(
        asset_repo: Arc<AssetRepository>,
        pack_repo: Arc<PackRepository>,
        indexer: Arc<Indexer>,
    ) -> Result<ReconcileReport> {
        // The walk + chunked DB passes are synchronous work over potentially
        // hundreds of thousands of files — keep it off the async runtime.
        tokio::task::spawn_blocking(move || Self::run_sync(asset_repo, pack_repo, indexer))
            .await
            .map_err(|e| crate::error::StackError::Other(e.to_string()))?
    }

    fn run_sync(
        asset_repo: Arc<AssetRepository>,
        pack_repo: Arc<PackRepository>,
        indexer: Arc<Indexer>,
    ) -> Result<ReconcileReport> {
        let start = Instant::now();
        let watched = pack_repo.list_watched()?;

        // Mark everything visited in this pass by bumping last_seen_at on rediscovery.
        let cutoff = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let mut new_files = 0usize;

        for wf in &watched {
            if !wf.is_active {
                continue;
            }
            let root = Path::new(&wf.path);
            if !root.exists() {
                continue;
            }
            let (files, _) = Scanner::scan(root)?;

            // Chunked set-membership instead of one SELECT + one UPDATE per
            // file: at 5–10TB library scale the per-file version was ~340k
            // round-trips on every app launch.
            let paths: Vec<String> = files
                .iter()
                .map(|f| f.path.to_string_lossy().to_string())
                .collect();
            let known: std::collections::HashSet<String> =
                asset_repo.existing_paths(&paths)?.into_iter().collect();

            let seen: Vec<String> = paths
                .iter()
                .filter(|p| known.contains(*p))
                .cloned()
                .collect();
            asset_repo.touch_last_seen_by_paths(&seen, cutoff)?;

            let mut jobs = Vec::new();
            for (f, path_str) in files.into_iter().zip(paths.iter()) {
                if known.contains(path_str) {
                    continue;
                }
                new_files += 1;
                // For project-kind watched folders the watched root *is*
                // the pack root; one pack per project regardless of subdirs.
                let pack_root = if wf.kind == "project" {
                    Some(root.to_path_buf())
                } else {
                    Scanner::detect_pack_root(&f.path, root)
                };
                jobs.push(crate::core::IndexJob {
                    path: f.path,
                    priority: crate::core::JobPriority::Low,
                    pack_root,
                });
            }
            if !jobs.is_empty() {
                indexer.enqueue_batch(jobs);
            }
        }

        let missing = asset_repo.mark_missing(cutoff)?;

        // Refresh pack asset counts and drop packs that no longer exist on disk
        // and have no active files — this is what keeps the sidebar honest after
        // the user moves or deletes folders outside the app.
        pack_repo.recount_all()?;
        let packs_removed = pack_repo.delete_empty_or_missing()?;

        Ok(ReconcileReport {
            new_files,
            missing_files: missing,
            duration_ms: start.elapsed().as_millis() as u64,
            packs_removed,
        })
    }
}
