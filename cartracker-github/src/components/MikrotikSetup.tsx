"use client";

import { useState } from "react";
import { buildMikrotikScript } from "@/lib/mikrotik";

export type MikrotikChoice = { connection: "public" | "local"; localUrl: string; vehicleId: string; intervalSeconds: number };

type Props = {
  urls: { public: string | null; local: string | null };
  token: string | null;
  value: MikrotikChoice;
  onChange: (value: MikrotikChoice) => void;
  onMessage: (text: string, error: boolean) => void;
};

export default function MikrotikSetup({ urls, token, value, onChange, onMessage }: Props) {
  const [showScript, setShowScript] = useState(false);
  const url = value.connection === "public" ? urls.public : value.localUrl || urls.local;
  const valid = Boolean(url && token && /^[A-Za-z0-9_-]{1,40}$/.test(value.vehicleId) && value.intervalSeconds >= 5);
  const generated = valid ? buildMikrotikScript({ url: url!, token: token!, vehicleId: value.vehicleId, intervalSeconds: value.intervalSeconds }) : null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      onMessage("Copied. Paste it into the MikroTik terminal (WinBox > New Terminal, or SSH) and press Enter.", false);
    } catch {
      onMessage("This browser only allows copying over HTTPS. Click in the box, select all (Ctrl+A) and copy (Ctrl+C).", true);
    }
  }

  return (
    <div className="mikrotik-setup">
      <div className="pbx-mode" role="radiogroup" aria-label="How the car reaches the server">
        <button type="button" role="radio" aria-checked={value.connection === "public"} className={value.connection === "public" ? "active" : undefined} disabled={!urls.public} onClick={() => onChange({ ...value, connection: "public" })}>
          Through the domain
        </button>
        <button type="button" role="radio" aria-checked={value.connection === "local"} className={value.connection === "local" ? "active" : undefined} onClick={() => onChange({ ...value, connection: "local" })}>
          Local network / VPN
        </button>
      </div>
      <p className="pbx-hint">
        {value.connection === "public"
          ? "The car sends its position over mobile data to your domain with HTTPS. Works anywhere."
          : "The car must be able to reach this address: on the same network, or over a VPN (e.g. WireGuard on the MikroTik) into this network."}
        {!urls.public && " A domain isn't set up on this server; run the installer with --reconfigure to add one."}
      </p>

      {value.connection === "local" && (
        <label className="pbx-field">
          Server address as the car sees it
          <input className="pbx-input" value={value.localUrl} placeholder={urls.local ?? "http://192.168.1.10/api/telemetry"} onChange={(e) => onChange({ ...value, localUrl: e.target.value.trim() })} />
        </label>
      )}
      <div className="mikrotik-row">
        <label className="pbx-field">Vehicle name<input className="pbx-input" value={value.vehicleId} maxLength={40} onChange={(e) => onChange({ ...value, vehicleId: e.target.value.trim() })} /></label>
        <label className="pbx-field">Report every (seconds)<input className="pbx-input" type="number" min={5} max={3600} value={value.intervalSeconds} onChange={(e) => onChange({ ...value, intervalSeconds: Number(e.target.value) })} /></label>
      </div>

      {generated ? (
        <>
          <label className="pbx-field">
            Paste this into the MikroTik terminal
            <textarea className="pbx-input mikrotik-code" readOnly rows={6} value={generated.install} onFocus={(e) => e.target.select()} />
          </label>
          <div className="panel-actions">
            <button className="media-upload-button" type="button" onClick={() => copy(generated.install)}>Copy</button>
            <button className="routes-action-btn" type="button" onClick={() => setShowScript((shown) => !shown)}>{showScript ? "Hide" : "Show"} readable script</button>
          </div>
          {showScript && <textarea className="pbx-input mikrotik-code" readOnly rows={14} value={generated.script} />}
          <p className="pbx-hint">
            It turns on the GPS, installs a script called <code>cartracker-report</code> and runs it every {value.intervalSeconds} seconds. Running it again replaces the old one.
            Needs RouterOS 7. Positions only appear once the GPS has a fix.
          </p>
        </>
      ) : (
        <p className="pbx-warning">{token ? "Fill in a valid address, vehicle name (letters, digits, - and _) and interval to generate the script." : "A vehicle token is needed first."}</p>
      )}
    </div>
  );
}
