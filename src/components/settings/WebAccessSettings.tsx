import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isTauri } from '../../lib/tauri-core';
import { useWebAccess, webAccessKey } from '../../hooks/useWebAccess';
import { Button } from '../ui/Button';
import { Copy, CopySuccess, Global, Warning2 } from '../ui/icons';
import { SettingRow, SettingSection, Toggle } from './primitives';
import type { Settings } from '../../types';

// In dev the bundled assets aren't on the server port (Tauri serves the UI from
// the Vite dev server), so point local access at Vite — it proxies /__ipc,
// /__media and /__events through to the embedded server.
const DEV_ORIGIN = 'http://localhost:1420';

/** One reachable URL with copy + open affordances. */
function UrlRow({ label, url, hint }: { label: string; url: string; hint?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const open = () => {
    if (isTauri) openUrl(url).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  };

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{label}</p>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            icon={
              copied
                ? <CopySuccess size={14} variant="Linear" color="currentColor" />
                : <Copy size={14} variant="Linear" color="currentColor" />
            }
            onClick={copy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Global size={14} variant="Linear" color="currentColor" />}
            onClick={open}
          >
            Open
          </Button>
        </div>
      </div>
      <p className="mono mt-1.5 break-all text-xs text-gray-300">{url}</p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}

export function WebAccessSettings({ settings, onChange }: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
}) {
  const qc = useQueryClient();
  const { data: info } = useWebAccess();
  const [port, setPort] = useState(String(settings.webAccessPort));

  // The backend restarts the server in place, so re-read the URLs whenever the
  // settings that decide where it listens change.
  useEffect(() => {
    setPort(String(settings.webAccessPort));
    qc.invalidateQueries({ queryKey: webAccessKey });
  }, [settings.webAccessEnabled, settings.webAccessLan, settings.webAccessPort, qc]);

  const commitPort = () => {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setPort(String(settings.webAccessPort));
      return;
    }
    if (n !== settings.webAccessPort) onChange({ webAccessPort: n });
  };

  const withToken = (base: string) =>
    info ? `${base}/?token=${encodeURIComponent(info.token)}` : base;
  const localUrl = import.meta.env.DEV
    ? withToken(DEV_ORIGIN)
    : info?.localUrl ?? `http://127.0.0.1:${settings.webAccessPort}/`;

  return (
    <SettingSection
      title="Web access"
      description="Open Stack in a browser. While the desktop app runs it serves the same UI from the same database and samples — nothing is uploaded anywhere."
    >
      <SettingRow
        label="Serve Stack in a browser"
        description="Runs a small HTTP server for as long as the app is open. Changes apply immediately, no restart."
      >
        <Toggle
          checked={settings.webAccessEnabled}
          onChange={(v) => onChange({ webAccessEnabled: v })}
        />
      </SettingRow>

      <SettingRow
        label="Allow other devices on this network"
        description="Off: this computer only. On: phones, tablets and other machines on the same Wi-Fi can reach your library."
      >
        <Toggle
          checked={settings.webAccessLan}
          disabled={!settings.webAccessEnabled}
          onChange={(v) => onChange({ webAccessLan: v })}
        />
      </SettingRow>

      <SettingRow
        label="Port"
        description="Change only if something else already uses this port."
      >
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          disabled={!settings.webAccessEnabled}
          onChange={(e) => setPort(e.target.value)}
          onBlur={commitPort}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          className="mono h-8 w-24 rounded-md border border-gray-700 bg-gray-800 px-2.5 text-xs text-stack-white outline-none transition-colors hover:border-gray-600 focus:border-stack-fire disabled:opacity-40"
        />
      </SettingRow>

      {settings.webAccessLan && (
        <div className="mx-3 flex gap-2.5 rounded-lg border border-stack-fire/40 bg-stack-ember/30 px-3 py-2.5 text-xs text-gray-300">
          <Warning2 size={16} variant="Linear" color="currentColor" className="mt-px shrink-0 text-stack-fire" />
          <p>
            Anyone on this network who has the link below can browse, play and edit your
            library. The link contains a secret token — treat it like a password, and only
            share it with devices you trust. Requests without the token are refused.
          </p>
        </div>
      )}

      {settings.webAccessEnabled && (
        <div className="space-y-2 px-3 pt-2">
          <UrlRow
            label="This computer"
            url={localUrl}
            hint="Open once in any browser here; the token is remembered afterwards."
          />
          {settings.webAccessLan && info?.lanUrl && (
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <UrlRow
                  label={`Other devices (${info.lanIp})`}
                  url={info.lanUrl}
                  hint="Point your phone's camera at the code, or open this link while on the same Wi-Fi."
                />
              </div>
              {info.lanQrSvg && (
                <div
                  className="shrink-0 overflow-hidden rounded-md bg-white p-1.5"
                  style={{ width: 104, height: 104 }}
                  // Generated by the Rust backend from the same URL shown
                  // beside it — the token makes that URL far too long to type
                  // on a phone.
                  aria-label="QR code to open Stack on another device"
                  dangerouslySetInnerHTML={{ __html: info.lanQrSvg }}
                />
              )}
            </div>
          )}
          {settings.webAccessLan && !info?.lanUrl && (
            <p className="text-xs text-gray-500">
              No local network address found. Connect to Wi-Fi or Ethernet and reopen Settings.
            </p>
          )}
          {info && !info.running && (
            <p className="text-xs text-stack-fire">
              Port {info.port} could not be opened — it is probably in use. Try another port.
            </p>
          )}
        </div>
      )}
    </SettingSection>
  );
}
