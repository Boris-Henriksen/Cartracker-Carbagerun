"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { MikrotikStatus } from "@/lib/mikrotik-state";

// Shared with the gallery and other admin pages so one unlock covers all of them in this tab.
const KEY_STORAGE = "cartracker-media-key";

type Overview = {
  site: { host: string; origin: string; telemetryUrl: string; lanAddress: string | null };
  vehicle: {
    tokenSet: boolean;
    tokenSource: "install" | "site" | null;
    tokenChangedAt: string | null;
    vehicles: { id: string; lastSeen: string; latest: { latitude: number; longitude: number } }[];
  };
  mikrotik: { status: MikrotikStatus; url: string | null };
  checklist: { pbxInstalled: boolean; sipHost: string | null; sipPort: number; rtpStart: number | null; rtpEnd: number | null };
  server: {
    dataDir: string;
    diskFree: number;
    diskTotal: number;
    sizes: { tracks: number; media: number; holdMusic: number; greeting: number; data: number };
    versions: { app: string | null; next: string | null; node: string; asterisk: string | null };
    uptimeSeconds: number;
  };
  counts: { routes: number; points: number; media: number; calls: number };
  adminCode: { source: "install" | "site"; changedAt?: string };
};

type Message = { text: string; error: boolean };

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Opening the site by IP or localhost means the DNS hint would show the wrong name.
function isAddressOnly(host: string): boolean {
  return host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export default function AdminOverviewPage() {
  const [key, setKey] = useState<string | null>(null);
  const [data, setData] = useState<Overview | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey(null);
    setData(null);
    setMessage(text ? { text, error: true } : null);
  }

  async function request(path: string, init: RequestInit = {}, code = key): Promise<Record<string, unknown> | null> {
    const response = await fetch(path, { ...init, cache: "no-store", headers: { ...init.headers, Authorization: `Bearer ${code}` } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      lock(body.error ?? "Locked");
      return null;
    }
    if (!response.ok) {
      setMessage({ text: body.error ?? `Request failed (${response.status})`, error: true });
      return null;
    }
    return body;
  }

  async function load(code: string) {
    const body = await request("/api/admin/overview", {}, code);
    if (!body) return false;
    setData(body as unknown as Overview);
    return true;
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(KEY_STORAGE);
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after mount
    setKey(saved);
    load(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only restore once on mount
  }, []);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const code = codeInputRef.current?.value ?? "";
    if (!code) return;
    if (codeInputRef.current) codeInputRef.current.value = "";
    if (!(await load(code))) return;
    sessionStorage.setItem(KEY_STORAGE, code);
    setKey(code);
    setMessage(null);
  }

  if (!key || !data) {
    return (
      <>
        {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Admin only</p><h2>Overview is locked</h2></div></div>
          <div className="control-empty">
            <span className="map-empty-mark">ADM</span>
            <strong>Enter the admin code</strong>
            <form className="media-unlock-form" onSubmit={unlock}>
              <input ref={codeInputRef} className="media-key-input" type="password" placeholder="Code" aria-label="Admin code" autoComplete="off" autoFocus />
              <button className="media-upload-button" type="submit">Unlock</button>
            </form>
            <span>Same code as the gallery and the other admin pages.</span>
          </div>
        </section>
      </>
    );
  }

  const { site, vehicle, checklist, server, counts, adminCode } = data;
  const forwardTo = site.lanAddress ?? "this server's LAN IP";

  return (
    <>
      {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
      <div className="pbx-layout">
        <section className="control-panel">
          <div className="panel-head">
            <div><p className="eyebrow">Tracker</p><h2>Connect the car (MikroTik)</h2></div>
            <div className="panel-actions">
              <button className="routes-action-btn" type="button" onClick={() => key && load(key)}>Refresh</button>
              <button className="routes-action-btn" type="button" onClick={() => lock()}>Done</button>
            </div>
          </div>
          <div className="pbx-sections">
            <fieldset className="pbx-section">
              <legend>MikroTik script</legend>
              <p className={data.mikrotik.status === "current" ? "pbx-hint" : "pbx-warning"}>
                {data.mikrotik.status === "current"
                  ? "The MikroTik has the current script."
                  : data.mikrotik.status === "outdated"
                    ? "Settings changed since the MikroTik was set up: it needs the new script."
                    : "Not set up yet."}
              </p>
              {data.mikrotik.url && <p className="pbx-hint">Reports to <code>{data.mikrotik.url}</code></p>}
              <Link className="routes-action-btn overview-link" href="/admin/mikrotik">Open MikroTik settings &amp; script</Link>
              <p className="pbx-hint">
                Vehicle token: {vehicle.tokenSource === "site" && vehicle.tokenChangedAt
                  ? `generated on this site on ${formatDate(vehicle.tokenChangedAt)}.`
                  : vehicle.tokenSource === "install"
                    ? "from the installation."
                    : "not set yet."}
              </p>
            </fieldset>

            <fieldset className="pbx-section">
              <legend>Last reports</legend>
              {vehicle.vehicles.length > 0 ? (
                <ul className="overview-list">
                  {vehicle.vehicles.map((v) => <li key={v.id}><span>{v.id}</span><span>{formatDate(v.lastSeen)}</span></li>)}
                </ul>
              ) : (
                <p className="pbx-hint">No position received yet.</p>
              )}
            </fieldset>
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Setup</p><h2>Checklist</h2></div></div>
          <div className="pbx-sections">
            <fieldset className="pbx-section">
              <legend>DNS records</legend>
              {isAddressOnly(site.host) ? (
                <p className="pbx-hint">You opened the site by address ({site.host}). Open it through your domain to see the exact record.</p>
              ) : (
                <p className="overview-item"><code>{site.host}</code> A record pointing to this server&apos;s public IP</p>
              )}
              {checklist.pbxInstalled &&
                (checklist.sipHost ? (
                  <p className="overview-item"><code>{checklist.sipHost}</code> pointing to the public IP, without Cloudflare proxy (phones can&apos;t go through it)</p>
                ) : (
                  <p className="pbx-hint">Phone calls: set a public IP or domain under Phone (PBX) → Network once you switch to Public.</p>
                ))}
            </fieldset>

            <fieldset className="pbx-section">
              <legend>Router port forwards to {forwardTo}</legend>
              <p className="overview-item"><code>TCP 80</code> website (certificate renewal and redirect)</p>
              <p className="overview-item"><code>TCP 443</code> website (HTTPS)</p>
              {checklist.pbxInstalled && (
                <>
                  <p className="overview-item"><code>UDP {checklist.sipPort}</code> phone signalling (SIP)</p>
                  <p className="overview-item">
                    <code>{checklist.rtpStart && checklist.rtpEnd ? `UDP ${checklist.rtpStart}-${checklist.rtpEnd}` : "UDP voice ports"}</code>{" "}
                    {checklist.rtpStart ? "call audio (RTP)" : "call audio (Asterisk not reachable right now, so the range can't be read)"}
                  </p>
                </>
              )}
            </fieldset>
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Server</p><h2>Status</h2></div></div>
          <div className="pbx-sections">
            <fieldset className="pbx-section">
              <legend>Disk</legend>
              <ul className="overview-list">
                <li><span>Free</span><span>{formatBytes(server.diskFree)} of {formatBytes(server.diskTotal)}</span></li>
                <li><span>All data</span><span>{formatBytes(server.sizes.data)}</span></li>
                <li><span>Routes</span><span>{formatBytes(server.sizes.tracks)}</span></li>
                <li><span>Photos &amp; videos</span><span>{formatBytes(server.sizes.media)}</span></li>
                <li><span>Hold music</span><span>{formatBytes(server.sizes.holdMusic)}</span></li>
                <li><span>Greeting</span><span>{formatBytes(server.sizes.greeting)}</span></li>
              </ul>
              <p className="pbx-hint">Data folder: <code>{server.dataDir}</code></p>
            </fieldset>

            <fieldset className="pbx-section">
              <legend>Software</legend>
              <ul className="overview-list">
                <li><span>CarTracker</span><span>{server.versions.app ?? "–"}</span></li>
                <li><span>Next.js</span><span>{server.versions.next ?? "–"}</span></li>
                <li><span>Node.js</span><span>{server.versions.node}</span></li>
                <li><span>Asterisk</span><span>{server.versions.asterisk ?? (checklist.pbxInstalled ? "Not reachable" : "Not installed")}</span></li>
                <li><span>Site running for</span><span>{formatUptime(server.uptimeSeconds)}</span></li>
                <li><span>Server LAN IP</span><span>{site.lanAddress ?? "–"}</span></li>
              </ul>
            </fieldset>

            <fieldset className="pbx-section">
              <legend>Content</legend>
              <ul className="overview-list">
                <li><span>Routes</span><span>{counts.routes}</span></li>
                <li><span>GPS points</span><span>{counts.points}</span></li>
                <li><span>Photos &amp; videos</span><span>{counts.media}</span></li>
                <li><span>Calls in history</span><span>{counts.calls}</span></li>
                <li><span>Admin code</span><span>{adminCode.source === "site" && adminCode.changedAt ? `Changed ${formatDate(adminCode.changedAt)}` : "From installation"}</span></li>
              </ul>
            </fieldset>
          </div>
        </section>
      </div>
    </>
  );
}
