"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { SiteSettings } from "@/lib/site-settings";

// Shared with the gallery and other admin pages so one unlock covers all of them in this tab.
const KEY_STORAGE = "cartracker-media-key";

type Message = { text: string; error: boolean };

export default function AdminSitePage() {
  const router = useRouter();
  const [key, setKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<SiteSettings | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey(null);
    setSettings(null);
    setMessage(text ? { text, error: true } : null);
  }

  async function request(init: RequestInit = {}, code = key): Promise<Record<string, unknown> | null> {
    const response = await fetch("/api/admin/site", { ...init, cache: "no-store", headers: { ...init.headers, Authorization: `Bearer ${code}` } });
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
    const body = await request({}, code);
    if (!body) return false;
    setSettings(body.settings as SiteSettings);
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
    const body = await request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    setBusy(false);
    if (!body) return;
    setSettings(body.settings as SiteSettings);
    setMessage({ text: "Site settings saved", error: false });
    // The site name and headline come from the server layout, so reload it.
    router.refresh();
  }

  const update = <K extends keyof SiteSettings>(field: K, value: SiteSettings[K]) =>
    setSettings((current) => (current ? { ...current, [field]: value } : current));

  if (!key || !settings) {
    return (
      <>
        {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Admin only</p><h2>Site settings are locked</h2></div></div>
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

  return (
    <>
      {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}
      <form className="control-panel" onSubmit={save}>
        <div className="panel-head">
          <div><p className="eyebrow">Site</p><h2>Name &amp; tracking</h2></div>
          <div className="panel-actions">
            <button className="media-upload-button" type="submit" disabled={busy}>Save</button>
            <button className="routes-action-btn" type="button" onClick={() => lock()}>Done</button>
          </div>
        </div>
        <div className="pbx-sections">
          <fieldset className="pbx-section">
            <legend>Name</legend>
            <label className="pbx-field">Site name<input className="pbx-input" value={settings.name} maxLength={40} onChange={(e) => update("name", e.target.value)} /></label>
            <label className="pbx-field">Front page headline<input className="pbx-input" value={settings.headline} maxLength={80} onChange={(e) => update("headline", e.target.value)} /></label>
            <p className="pbx-hint">Shown in the top bar, the browser tab and on the tracking page.</p>
          </fieldset>
          <fieldset className="pbx-section">
            <legend>Tracking</legend>
            <label className="pbx-field">Start a new route after (hours without signal)<input className="pbx-input" type="number" min={0.25} max={48} step={0.25} value={settings.routeGapHours} onChange={(e) => update("routeGapHours", Number(e.target.value))} /></label>
            <label className="pbx-field">Only save a point after moving (metres)<input className="pbx-input" type="number" min={0} max={500} value={settings.minMoveMeters} onChange={(e) => update("minMoveMeters", Number(e.target.value))} /></label>
            <label className="pbx-field">Keep at most (points per vehicle)<input className="pbx-input" type="number" min={500} max={100000} step={500} value={settings.maxPoints} onChange={(e) => update("maxPoints", Number(e.target.value))} /></label>
            <p className="pbx-hint">The movement limit filters GPS jitter while parked. When the point limit is reached, the oldest points are removed.</p>
          </fieldset>
        </div>
      </form>
    </>
  );
}
