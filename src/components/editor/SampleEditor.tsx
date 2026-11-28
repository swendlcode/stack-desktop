import { useEffect, useRef, useState, useCallback } from "react";
import { useUiStore } from "../../stores/uiStore";
import { useEditorStore } from "../../stores/editorStore";
import { useAsset } from "../../hooks/useAssets";
import { useEditorEngine } from "../../hooks/useEditorEngine";
import { editorEngine } from "../../services/editorEngine";
import { assetService } from "../../services/assetService";
import { dragService } from "../../services/dragService";
import { usePlayerStore } from "../../stores/playerStore";
import { EditorWaveform } from "./EditorWaveform";
import { EditorControls } from "./EditorControls";
import { EditorDock } from "./EditorDock";
import { CloseCircle } from "../ui/icons";
import { formatDuration, formatBpm, formatKey } from "../../utils/formatters";

export function SampleEditor() {
  const editorAssetId = useUiStore((s) => s.editorAssetId);
  const closeEditor = useUiStore((s) => s.closeEditor);
  const { data: asset } = useAsset(editorAssetId);
  const { currentTime, duration, reversed } = useEditorEngine();
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [dragging, setDragging] = useState(false);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const lastAutoPlayedIdRef = useRef<string | null>(null);
  const resetEditorStore = useEditorStore((s) => s.reset);

  // Recompute displayed samples whenever the work buffer changes (reverse/normalize)
  const refreshSamples = useCallback(() => {
    void editorEngine.monoSamples().then((mono) => {
      if (mono) setSamples(mono);
    });
  }, []);

  // Stop main playback + load sample into the editor engine when opened.
  // Every sample open starts from defaults — prior edits never leak across.
  useEffect(() => {
    if (!editorAssetId || !asset) return;
    if (asset.type !== "sample") return;
    usePlayerStore.getState().pause();
    resetEditorStore();
    setSamples(null);
    editorEngine
      .load(asset.path)
      .then((ok) => {
        if (!ok) return;
        editorEngine.resetEdits();
        // Loop is the transport's setting, not the sample's: opening the
        // next sound keeps looping if the player bar says so (issue #16).
        // `resetEdits` has just set the loop to the whole file, so this
        // repeats all of it until a region is dragged over the waveform.
        if (usePlayerStore.getState().loopOn) void editorEngine.setLoop(true);
        refreshSamples();
        // Editor-open workflow: whenever sample selection changes (arrow/click in table),
        // auto-preview once in editor so navigation always has audible feedback.
        if (lastAutoPlayedIdRef.current !== asset.id) {
          lastAutoPlayedIdRef.current = asset.id;
          usePlayerStore.getState().play(asset);
        }

        if (usePlayerStore.getState().isPlaying && !editorEngine.playing) {
          editorEngine.play();
        }
      })
      .catch(() => {});
    return () => {
      editorEngine.unload();
    };
  }, [editorAssetId, asset, resetEditorStore, refreshSamples]);

  // The player bar's volume is the editor's volume too. On the desktop the
  // mixer already applies it to the editor's voice; this is what carries it
  // in browser mode, where the editor has its own Web Audio graph.
  const masterVolume = usePlayerStore((s) => s.volume);
  useEffect(() => {
    editorEngine.setMonitorVolume(masterVolume);
  }, [masterVolume]);

  // Re-derive displayed samples whenever reverse/normalize changes the work buffer
  useEffect(() => {
    refreshSamples();
  }, [reversed, refreshSamples]);

  // Fetch/derive waveform peaks for display
  useEffect(() => {
    if (!asset) return;
    if (asset.waveformData && asset.waveformData.length) {
      setPeaks(asset.waveformData);
      return;
    }
    assetService
      .getWaveform(asset.id)
      .then((w) => setPeaks(w ?? null))
      .catch(() => setPeaks(null));
  }, [asset]);

  // Keep editor engine in sync with the global play state
  useEffect(() => {
    if (!asset || asset.id !== editorAssetId) return;

    const unsub = editorEngine.subscribe(() => {
      const state = usePlayerStore.getState();
      // While the editor owns playback, the main audioEngine is stopped and no
      // longer drives the shared player store's currentTime. Mirror the editor
      // engine's time/duration into the store so the list row's WaveformViewer
      // (which reads progress = currentTime / duration from the store) scrubs in
      // sync with the editor instead of freezing.
      if (state.currentAsset?.id === asset.id) {
        if (editorEngine.duration > 0) state.setDuration(editorEngine.duration);
        state.setCurrentTime(editorEngine.currentTime);
      }
      // Mirror the editor's transport into the store, both ways, so the
      // player bar and the list row agree with what is actually sounding.
      // The store no longer drives playback while the editor is open — it
      // reports it.
      if (state.currentAsset?.id === asset.id) {
        if (!editorEngine.playing && state.isPlaying) state.pause();
        else if (editorEngine.playing && !state.isPlaying) state.resume();
      }
    });

    if (isPlaying && !editorEngine.playing) {
      editorEngine.play();
    } else if (!isPlaying && editorEngine.playing) {
      editorEngine.pause();
    }

    return unsub;
  }, [isPlaying, asset, editorAssetId]);

  // Keyboard: Esc to close, Space to toggle play, Delete to cut selected region
  useEffect(() => {
    if (!editorAssetId) return;
    const onKey = (e: KeyboardEvent) => {
      // Don't intercept when focus is inside an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const currentAsset = asset;
      if (!currentAsset) return;

      if (e.key === "Escape") {
        e.preventDefault();
        closeEditor();
      } else if (e.key === " ") {
        e.preventDefault();
        const { isPlaying, play, stop } = usePlayerStore.getState();
        isPlaying ? stop() : play(currentAsset);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // Delete the loop-selected region and merge the surrounding audio
        const { loopOn, loopStart, loopEnd } = editorEngine;
        if (!loopOn || loopEnd <= loopStart) return;
        e.preventDefault();
        // The splice happens in the backend, so the new shape has to be
        // asked for once it is done rather than read straight back.
        void editorEngine.deleteRegion(loopStart, loopEnd).then(() =>
          editorEngine.monoSamples().then((mono) => {
            if (mono) setSamples(mono);
          }),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editorAssetId, closeEditor, asset]);

  if (!editorAssetId || !asset) return null;

  if (asset.type !== "sample") {
    return (
      <EditorDock>
        <div className="px-4 py-6 text-sm text-gray-400">
          The editor only supports audio samples. Selected: <b>{asset.type}</b>.
        </div>
      </EditorDock>
    );
  }

  const displayName = asset.filename;

  return (
    <EditorDock>
      <header className="flex items-center justify-between border-b border-gray-700/60 px-4 py-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2
            className="truncate text-sm font-medium text-stack-white"
            title={displayName}
          >
            {displayName}
          </h2>
          <span className="mono text-xs text-gray-500">
            {formatDuration(asset.durationMs ?? null)}
            {asset.bpm != null ? ` · ${formatBpm(asset.bpm)} BPM` : ""}
            {asset.keyNote
              ? ` · ${formatKey(asset.keyNote, asset.keyScale)}`
              : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="mono text-[11px] text-gray-500">
            {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
          </span>
          <span className="text-[10px] text-gray-600 hidden lg:inline">
            Click: seek · Shift-drag: loop · Del: cut region · Right-click:
            tools · ⌘/Ctrl-scroll: zoom
          </span>
          <button
            onClick={closeEditor}
            className="rounded p-1 text-gray-400 hover:bg-gray-800 hover:text-stack-white"
            aria-label="Close editor"
            title="Close (Esc)"
          >
            <CloseCircle size={18} color="currentColor" variant="Linear" />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 px-4 pb-1 pt-2">
        <EditorWaveform
          samples={samples}
          peaks={peaks}
          bpm={asset.bpm ?? null}
        />
      </div>

      <EditorControls
        assetBpm={asset.bpm ?? null}
        onDragExport={async (e) => {
          e.preventDefault();
          if (dragging) return;
          setDragging(true);
          try {
            const base = asset.filename.replace(/\.[^.]+$/, "");
            const path = await editorEngine.exportEdit(`${base} (edit).wav`);
            if (!path) return;
            await dragService.startExportDragPath(path);
          } finally {
            setDragging(false);
          }
        }}
        dragging={dragging}
      />
    </EditorDock>
  );
}
