"use client";

import { useEffect, useRef, useState } from "react";
import type { LockoutEntry, SecuritySettings } from "@/lib/admin-auth";

// Shared with the gallery and PBX tab so one unlock covers all admin pages in this tab.
const KEY_STORAGE = "cartracker-media-key";

type BlockedEntry = LockoutEntry & { you: boolean };
type Message = { text: string; error: boolean };

function formatClock(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// A short, readable hint of which browser/phone a device entry belongs to.
function describeAgent(userAgent: string): string {
  const os = /iPhone|iPad|Android|Windows|Mac OS|Linux/.exec(userAgent)?.[0] ?? "";
  const browser = /Edg|Firefox|Chrome|Safari|curl|MicroSIP/.exec(userAgent)?.[0]?.replace("Edg", "Edge") ?? "";
  return [browser, os].filter(Boolean).join(" on ") || "Unknown browser";
}

export default function AdminPage() {
  const [key, setKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const codeFormRef = useRef<HTMLFormElement | null>(null);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey(null);
    setSettings(null);
    setMessage(text ? { text, error: true } : null);
  }

  async function request(init: RequestInit = {}, code = key): Promise<Record<string, unknown> | null> {
    const response = await fetch("/api/admin/security", { ...init, cache: "no-store", headers: { ...init.headers, Authorization: `Bearer ${code}` } });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 || response.status === 403) {
      lock(data.error ?? "Locked");
      return null;
    }
    if (!response.ok) {
      setMessage({ text: data.error ?? `Request failed (${response.status})`, error: true });
      return null;
    }
    return data;
  }

  function showBlocked(entries: BlockedEntry[]) {
    setBlocked(entries);
    setCheckedAt(Date.now());
  }

  async function load(code: string) {
    const data = await request({}, code);
    if (!data) return false;
    setSettings(data.settings as SecuritySettings);
    showBlocked(data.blocked as BlockedEntry[]);
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

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setBusy(true);
    const data = await request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    setBusy(false);
    if (!data) return;
    setSettings(data.settings as SecuritySettings);
    showBlocked(data.blocked as BlockedEntry[]);
    setMessage({ text: "Protection settings saved", error: false });
  }

  async function unblock(entryKey?: string) {
    setBusy(true);
    const data = await request({ method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entryKey ? { key: entryKey } : {}) });
    setBusy(false);
    if (!data) return;
    showBlocked(data.blocked as BlockedEntry[]);
    setMessage({ text: entryKey ? "Unblocked" : "Everything unblocked", error: false });
  }

  async function refresh() {
    if (key) await load(key);
  }

  async function changeCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = String(form.get("current") ?? "");
    const next = String(form.get("next") ?? "");
    if (next !== String(form.get("repeat") ?? "")) return setMessage({ text: "The new codes don't match", error: true });

    setBusy(true);
    const response = await fetch("/api/admin/code", {
      method: "POST",
      headers: { Authorization: `Bearer ${current}`, "Content-Type": "application/json" },
      body: JSON.stringify({ newCode: next }),
    });
    setBusy(false);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 403) return lock(data.error ?? "Locked");
      return setMessage({ text: data.error ?? `Request failed (${response.status})`, error: true });
    }
    codeFormRef.current?.reset();
    sessionStorage.setItem(KEY_STORAGE, next);
    setKey(next);
    setMessage({ text: "Admin code changed. Use the new code from now on, on every device.", error: false });
  }

  const update = <K extends keyof SecuritySettings>(field: K, value: SecuritySettings[K]) =>
    setSettings((current) => (current ? { ...current, [field]: value } : current));

  return (
    <>
      {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}

      {!key || !settings ? (
        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Admin only</p><h2>Admin settings are locked</h2></div></div>
          <div className="control-empty">
            <span className="map-empty-mark">ADM</span>
            <strong>Enter the admin code</strong>
            <form className="media-unlock-form" onSubmit={unlock}>
              <input ref={codeInputRef} className="media-key-input" type="password" placeholder="Code" aria-label="Admin code" autoComplete="off" autoFocus />
              <button className="media-upload-button" type="submit">Unlock</button>
            </form>
            <span>Same code as the gallery and PBX tab.</span>
          </div>
        </section>
      ) : (
        <div className="pbx-layout">
          <form className="control-panel" onSubmit={save}>
            <div className="panel-head">
              <div><p className="eyebrow">Wrong-code protection</p><h2>Blocking</h2></div>
              <div className="panel-actions">
                <button className="media-upload-button" type="submit" disabled={busy}>Save</button>
                <button className="routes-action-btn" type="button" onClick={() => lock()}>Done</button>
              </div>
            </div>

            <div className="pbx-mode-row">
              <div className="pbx-mode" role="radiogroup" aria-label="Block mode">
                {(["device", "network"] as const).map((mode) => (
                  <button key={mode} type="button" role="radio" aria-checked={settings.mode === mode} className={settings.mode === mode ? "active" : undefined} onClick={() => update("mode", mode)}>
                    {mode === "device" ? "Per device" : "Per network"}
                  </button>
                ))}
              </div>
              <p className="pbx-hint">
                {settings.mode === "device"
                  ? "Only the phone or browser typing wrong codes is blocked. Others on the same Wi-Fi or mobile network can still log in."
                  : "The whole network (public IP) is blocked. Stricter, but everyone sharing that IP, like a mobile network or office, is blocked too."}
              </p>
            </div>

            <div className="pbx-sections">
              <fieldset className="pbx-section">
                <legend>Limits</legend>
                <label className="pbx-field">Wrong codes before blocking<input className="pbx-input" type="number" min={3} max={20} value={settings.maxAttempts} onChange={(e) => update("maxAttempts", Number(e.target.value))} /></label>
                <label className="pbx-field">Block for (minutes)<input className="pbx-input" type="number" min={1} max={1440} value={settings.lockMinutes} onChange={(e) => update("lockMinutes", Number(e.target.value))} /></label>
                <label className="pbx-field">
                  Network safety limit
                  <input className="pbx-input" type="number" min={10} max={500} value={settings.networkMaxAttempts} disabled={settings.mode !== "device"} onChange={(e) => update("networkMaxAttempts", Number(e.target.value))} />
                </label>
                <p className="pbx-hint">
                  The network safety limit stops scripts that dodge per-device blocking. Keep it well above the normal limit so a busy network isn&apos;t blocked by one person.
                </p>
              </fieldset>
            </div>
          </form>

          <section className="control-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Wrong codes</p><h2>Blocked &amp; watched ({blocked.length})</h2></div>
              <div className="panel-actions">
                <button className="routes-action-btn" type="button" onClick={refresh}>Refresh</button>
                <button className="reset-button" type="button" onClick={() => unblock()} disabled={busy || blocked.length === 0}>Unblock all</button>
              </div>
            </div>
            {blocked.length > 0 ? (
              <div className="pbx-calls">
                <table>
                  <thead><tr><th>Type</th><th>Who</th><th>IP</th><th>Wrong codes</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {blocked.map((entry) => {
                      const isBlocked = (entry.lockedUntil ?? 0) > checkedAt;
                      return (
                        <tr key={entry.key}>
                          <td>{entry.kind === "device" ? "Device" : "Network"}</td>
                          <td>{entry.kind === "device" ? `${describeAgent(entry.userAgent)}${entry.you ? " (you)" : ""}` : "Everyone on this IP"}</td>
                          <td>{entry.ip}</td>
                          <td>{entry.failures}</td>
                          <td className={`pbx-result ${isBlocked ? "missed" : "answered"}`}>
                            {isBlocked ? `Blocked until ${formatClock(entry.lockedUntil!)}` : `Last try ${formatClock(entry.lastFailure)}`}
                          </td>
                          <td><button className="routes-action-btn" type="button" onClick={() => unblock(entry.key)} disabled={busy}>Unblock</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="pbx-hint pbx-moh-empty">Nobody is blocked. Devices and networks with recent wrong codes appear here.</p>
            )}
          </section>

          <form ref={codeFormRef} className="control-panel" onSubmit={changeCode}>
            <div className="panel-head">
              <div><p className="eyebrow">Login</p><h2>Admin code</h2></div>
              <button className="media-upload-button" type="submit" disabled={busy}>Change code</button>
            </div>
            <div className="pbx-sections">
              <fieldset className="pbx-section">
                <legend>Change the admin code</legend>
                <label className="pbx-field">Current code<input className="pbx-input" name="current" type="password" required autoComplete="current-password" /></label>
                <label className="pbx-field">New code<input className="pbx-input" name="next" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
                <label className="pbx-field">Repeat new code<input className="pbx-input" name="repeat" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
                <p className="pbx-hint">
                  At least 12 characters. Used for the gallery, routes and all admin pages; other devices have to log in again with the new code.
                  Forgot it? Delete <code>admin-code.json</code> in the data folder on the server and the original code from the install works again.
                </p>
              </fieldset>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
