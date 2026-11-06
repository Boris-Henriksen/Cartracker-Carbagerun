"use client";

import { useEffect, useRef, useState } from "react";
import MikrotikSetup, { type MikrotikChoice } from "@/components/MikrotikSetup";
import type { MikrotikStatus } from "@/lib/mikrotik-state";

// Shared with the gallery and other admin pages so one unlock covers all of them in this tab.
const KEY_STORAGE = "cartracker-media-key";

type State = {
  settings: MikrotikChoice;
  urls: { public: string | null; local: string | null };
  token: string | null;
  status: MikrotikStatus;
  lastReports: { id: string; lastSeen: string }[];
};

type Message = { text: string; error: boolean };

const STATUS_TEXT: Record<MikrotikStatus, string> = {
  never: "Not confirmed yet. Paste the script on the MikroTik, then press \u201cMikroTik updated\u201d.",
  current: "The MikroTik has the current script.",
  outdated: "Settings changed since the MikroTik was set up. Paste the new script on the MikroTik, then press \u201cMikroTik updated\u201d.",
};

function sameChoice(a: MikrotikChoice, b: MikrotikChoice) {
  return a.connection === b.connection && a.localUrl === b.localUrl && a.vehicleId === b.vehicleId && a.intervalSeconds === b.intervalSeconds;
}

export default function AdminMikrotikPage() {
  const [key, setKey] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<MikrotikChoice | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey(null);
    setState(null);
    setMessage(text ? { text, error: true } : null);
  }

  async function request(init: RequestInit = {}, code = key): Promise<State | null> {
    const response = await fetch("/api/admin/mikrotik", {
      ...init,
      cache: "no-store",
      headers: { ...init.headers, Authorization: `Bearer ${code}`, "Content-Type": "application/json" },
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      lock(body.error ?? "Locked");
      return null;
    }
    if (!response.ok) {
      setMessage({ text: body.error ?? `Request failed (${response.status})`, error: true });
      return null;
    }
    const next = body as State;
    setState(next);
    setDraft(next.settings);
    return next;
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(KEY_STORAGE);
    if (!saved) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after mount
    setKey(saved);
    request({}, saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only restore once on mount
  }, []);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const code = codeInputRef.current?.value ?? "";
    if (!code) return;
    if (codeInputRef.current) codeInputRef.current.value = "";
    if (!(await request({}, code))) return;
    sessionStorage.setItem(KEY_STORAGE, code);
    setKey(code);
    setMessage(null);
  }

  async function act(init: RequestInit, success: string) {
    setBusy(true);
    const next = await request(init);
    setBusy(false);
    if (next) setMessage({ text: next.status === "outdated" ? `${success} Remember to update the MikroTik with the new script.` : success, error: next.status === "outdated" });
  }

  if (!key || !state || !draft) {
    return (
      <>
        {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Admin only</p><h2>MikroTik settings are locked</h2></div></div>
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

  const unsaved = !sameChoice(draft, state.settings);

  return (
    <>
      {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
      <div className="pbx-layout">
        <section className="control-panel">
          <div className="panel-head">
            <div><p className="eyebrow">MikroTik</p><h2>Script status</h2></div>
            <div className="panel-actions">
              <span className={`online-label${state.status === "current" ? "" : " parked"}`}>{state.status === "current" ? "Up to date" : state.status === "outdated" ? "Needs update" : "Not set up"}</span>
              <button className="routes-action-btn" type="button" onClick={() => request()}>Refresh</button>
              <button className="routes-action-btn" type="button" onClick={() => lock()}>Done</button>
            </div>
          </div>
          <div className="pbx-sections">
            <fieldset className="pbx-section">
              <legend>On the router</legend>
              <p className={state.status === "current" ? "pbx-hint" : "pbx-warning"}>{STATUS_TEXT[state.status]}</p>
              <button className="media-upload-button" type="button" disabled={busy || unsaved || state.status === "current"} onClick={() => act({ method: "POST", body: JSON.stringify({ action: "installed" }) }, "Marked as updated.")}>
                MikroTik updated
              </button>
              {unsaved && <p className="pbx-hint">Save your changes first.</p>}
            </fieldset>
            <fieldset className="pbx-section">
              <legend>Last reports</legend>
              {state.lastReports.length > 0 ? (
                <ul className="overview-list">
                  {state.lastReports.map((report) => <li key={report.id}><span>{report.id}</span><span>{new Date(report.lastSeen).toLocaleString()}</span></li>)}
                </ul>
              ) : (
                <p className="pbx-hint">No position received yet.</p>
              )}
            </fieldset>
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-head">
            <div><p className="eyebrow">Settings &amp; script</p><h2>Connection</h2></div>
            <div className="panel-actions">
              {unsaved && <span className="online-label parked">Unsaved changes</span>}
              <button className="routes-action-btn" type="button" disabled={busy || !unsaved} onClick={() => setDraft(state.settings)}>Undo</button>
              <button className="media-upload-button" type="button" disabled={busy || !unsaved} onClick={() => act({ method: "PUT", body: JSON.stringify({ mikrotik: draft }) }, "Settings saved.")}>Save</button>
            </div>
          </div>
          <div className="overview-command">
            <MikrotikSetup urls={state.urls} token={state.token} value={draft} onChange={setDraft} onMessage={(text, error) => setMessage({ text, error })} />
            {unsaved && <p className="pbx-warning">The script above already shows your unsaved changes. Save, then paste it on the MikroTik.</p>}
          </div>
        </section>

        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Security</p><h2>Vehicle token</h2></div></div>
          <div className="pbx-sections">
            <fieldset className="pbx-section">
              <legend>Token in the script</legend>
              <p className="pbx-hint">
                The car sends this token with every position. Generate a new one if the router is lost or the script was shared.
                The old token stops working immediately, so the MikroTik needs the new script.
              </p>
              <button
                className="reset-button"
                type="button"
                disabled={busy}
                onClick={() => window.confirm("Generate a new vehicle token? The car stops reporting until the MikroTik gets the new script.") && act({ method: "POST", body: JSON.stringify({ action: "regenerate-token" }) }, "New token generated.")}
              >
                Generate new token
              </button>
            </fieldset>
          </div>
        </section>
      </div>
    </>
  );
}
