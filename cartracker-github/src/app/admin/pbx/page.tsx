"use client";

import { useEffect, useRef, useState } from "react";
import type { ApplyResult, AsteriskStatus, MohFile, PbxPublicSettings } from "@/lib/pbx";
import type { CallLogEntry, CarCallState } from "@/lib/pbx-events";
import { SIP_PORT } from "@/lib/pbx-constants";

// Shared with the gallery so one unlock covers both admin pages in this tab.
const KEY_STORAGE = "cartracker-media-key";
const MAX_MOH_UPLOAD_BYTES = 50 * 1024 * 1024;
const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4",
};

type Draft = Omit<PbxPublicSettings, "moh" | "trunk" | "phone" | "test"> & {
  trunk: Omit<PbxPublicSettings["trunk"], "passwordSet">;
  phone: Omit<PbxPublicSettings["phone"], "passwordSet">;
  test: Omit<PbxPublicSettings["test"], "passwordSet">;
};

type Message = { text: string; error: boolean };

const CALL_STATE_LABEL: Record<CarCallState, string> = { idle: "Free", ringing: "Ringing", "on-call": "On a call", unknown: "Unknown" };
const RESULT_LABEL: Record<CallLogEntry["result"], string> = {
  answered: "Answered", missed: "Missed", busy: "Busy", failed: "Failed", party: "Party line",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

type CallGroup<T> = { key: string; label: string; items: T[] };

// Calls arrive newest first, so groups and their contents stay newest first too.
function groupBy<T>(items: T[], keyOf: (item: T) => string, labelOf: (item: T) => string): CallGroup<T>[] {
  const groups: CallGroup<T>[] = [];
  for (const item of items) {
    const key = keyOf(item);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) groups.push((group = { key, label: labelOf(item), items: [] }));
    group.items.push(item);
  }
  return groups;
}

function groupCalls(calls: CallLogEntry[]) {
  const date = (entry: CallLogEntry) => new Date(entry.start);
  return groupBy(calls, (c) => String(date(c).getFullYear()), (c) => String(date(c).getFullYear())).map((year) => ({
    ...year,
    months: groupBy(year.items, (c) => String(date(c).getMonth()), (c) => date(c).toLocaleString(undefined, { month: "long" })).map((month) => ({
      ...month,
      days: groupBy(month.items, (c) => String(date(c).getDate()), (c) => date(c).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })),
    })),
  }));
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function toDraft(settings: PbxPublicSettings): Draft {
  return {
    mode: settings.mode,
    trunk: { enabled: settings.trunk.enabled, host: settings.trunk.host, port: settings.trunk.port, username: settings.trunk.username, password: "", number: settings.trunk.number },
    phone: { extension: settings.phone.extension, password: "" },
    network: { ...settings.network },
    inbound: { ...settings.inbound },
    menu: { ...settings.menu },
    queue: { ...settings.queue },
    party: { ...settings.party },
    test: { enabled: settings.test.enabled, extension: settings.test.extension, password: "" },
  };
}

// Browsers report an empty type for some audio files, so fall back to the extension.
function audioType(file: File): string {
  return file.type || TYPE_BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""] || "";
}

function appliedMessage(applied: ApplyResult, done: string): Message {
  return applied.ok ? { text: `${done} and applied to Asterisk`, error: false } : { text: `${done}, but not applied: ${applied.error}`, error: true };
}

export default function PbxPage() {
  const [key, setKey] = useState<string | null>(null);
  const [settings, setSettings] = useState<PbxPublicSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [status, setStatus] = useState<AsteriskStatus | null>(null);
  const [call, setCall] = useState<CarCallState>("unknown");
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [lanAddress, setLanAddress] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const greetingInputRef = useRef<HTMLInputElement | null>(null);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setKey(null);
    setSettings(null);
    setDraft(null);
    setStatus(null);
    setMessage(text ? { text, error: true } : null);
  }

  async function request(path: string, init: RequestInit = {}, code = key): Promise<Record<string, unknown> | null> {
    const response = await fetch(path, { ...init, cache: "no-store", headers: { ...init.headers, Authorization: `Bearer ${code}` } });
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

  async function load(code: string) {
    const data = await request("/api/pbx", {}, code);
    if (!data) return false;
    const loaded = data.settings as PbxPublicSettings;
    setSettings(loaded);
    setDraft(toDraft(loaded));
    setStatus(data.status as AsteriskStatus);
    setCall(data.call as CarCallState);
    setCalls(data.calls as CallLogEntry[]);
    setLanAddress(data.lanAddress as string | null);
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
    if (!draft) return;
    setBusy(true);
    const data = await request("/api/pbx", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    setBusy(false);
    if (!data) return;
    const saved = data.settings as PbxPublicSettings;
    setSettings(saved);
    setDraft(toDraft(saved));
    setMessage(appliedMessage(data.applied as ApplyResult, "Settings saved"));
  }

  async function refreshStatus() {
    const data = await request("/api/pbx");
    if (!data) return;
    setStatus(data.status as AsteriskStatus);
    setCall(data.call as CarCallState);
    setCalls(data.calls as CallLogEntry[]);
  }

  async function uploadGreeting(fileList: FileList | null) {
    const file = fileList?.[0];
    if (greetingInputRef.current) greetingInputRef.current.value = "";
    if (!file) return;
    const type = audioType(file);
    if (!type) return setMessage({ text: "Only MP3, WAV, OGG, FLAC and M4A files are allowed", error: true });
    if (file.size > MAX_MOH_UPLOAD_BYTES) return setMessage({ text: "File is larger than 50 MB", error: true });

    setBusy(true);
    setMessage({ text: `Uploading and converting ${file.name}…`, error: false });
    const data = await request("/api/pbx/greeting", {
      method: "POST",
      headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    setBusy(false);
    if (!data) return;
    setSettings(data.settings as PbxPublicSettings);
    setMessage(appliedMessage(data.applied as ApplyResult, "Greeting uploaded"));
  }

  async function deleteGreeting() {
    if (!window.confirm("Remove the welcome greeting?")) return;
    setBusy(true);
    const data = await request("/api/pbx/greeting", { method: "DELETE" });
    setBusy(false);
    if (!data) return;
    setSettings(data.settings as PbxPublicSettings);
    setMessage(appliedMessage(data.applied as ApplyResult, "Greeting removed"));
  }

  async function uploadMoh(fileList: FileList | null) {
    const file = fileList?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !settings) return;
    const type = audioType(file);
    if (!type) return setMessage({ text: "Only MP3, WAV, OGG, FLAC and M4A files are allowed", error: true });
    if (file.size > MAX_MOH_UPLOAD_BYTES) return setMessage({ text: "File is larger than 50 MB", error: true });

    setBusy(true);
    setMessage({ text: `Uploading and converting ${file.name}…`, error: false });
    const data = await request("/api/pbx/moh", {
      method: "POST",
      headers: { "Content-Type": type, "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    });
    setBusy(false);
    if (!data) return;
    setSettings({ ...settings, moh: data.moh as MohFile[] });
    setMessage(appliedMessage(data.applied as ApplyResult, "Hold music added"));
  }

  async function deleteMoh(item: MohFile) {
    if (!settings || !window.confirm(`Delete "${item.name}"?`)) return;
    setBusy(true);
    const data = await request(`/api/pbx/moh/${item.file}`, { method: "DELETE" });
    setBusy(false);
    if (!data) return;
    setSettings({ ...settings, moh: data.moh as MohFile[] });
    setMessage(appliedMessage(data.applied as ApplyResult, "Hold music removed"));
  }

  function update<S extends Exclude<keyof Draft, "mode">>(section: S, field: keyof Draft[S], value: Draft[S][keyof Draft[S]]) {
    setDraft((current) => (current ? { ...current, [section]: { ...current[section], [field]: value } } : current));
  }

  const unlocked = key !== null && settings !== null && draft !== null;

  return (
    <>
      {message && <div className={`media-message pbx-message${message.error ? " error" : ""}`}>{message.text}</div>}

      {!unlocked ? (
        <section className="control-panel">
          <div className="panel-head"><div><p className="eyebrow">Admin only</p><h2>PBX settings are locked</h2></div></div>
          <div className="control-empty">
            <span className="map-empty-mark">PBX</span>
            <strong>Enter the admin code</strong>
            <form className="media-unlock-form" onSubmit={unlock}>
              <input ref={codeInputRef} className="media-key-input" type="password" placeholder="Code" aria-label="Admin code" autoComplete="off" autoFocus />
              <button className="media-upload-button" type="submit">Unlock</button>
            </form>
            <span>Same code as the gallery. Wrong codes count towards the lockout.</span>
          </div>
        </section>
      ) : (
        <div className="pbx-layout">
          <section className="control-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Asterisk</p><h2>Status</h2></div>
              <div className="panel-actions">
                <span className={`online-label${status?.connected ? "" : " parked"}`}>{status?.connected ? "Connected" : "Offline"}</span>
                {status?.connected && <span className={`online-label${call === "idle" ? " parked" : ""}`}>Car: {CALL_STATE_LABEL[call]}</span>}
                <button className="routes-action-btn" type="button" onClick={refreshStatus}>Refresh</button>
                <button className="routes-action-btn" type="button" onClick={() => lock()}>Done</button>
              </div>
            </div>
            <div className="pbx-status">
              {status?.connected ? (
                <>
                  <div><p className="eyebrow">Phone line registration</p><pre>{status.registrations || "—"}</pre></div>
                  <div><p className="eyebrow">Registered phones</p><pre>{status.contacts || "—"}</pre></div>
                </>
              ) : (
                <p className="pbx-hint">{status?.error ?? "Checking…"} Settings are still saved and applied once Asterisk is reachable.</p>
              )}
            </div>
          </section>

          <form className="control-panel" onSubmit={save}>
            <div className="panel-head">
              <div><p className="eyebrow">Configuration</p><h2>Settings</h2></div>
              <button className="media-upload-button" type="submit" disabled={busy}>Save &amp; apply</button>
            </div>

            <div className="pbx-mode-row">
              <div className="pbx-mode" role="radiogroup" aria-label="Mode">
                {(["local", "public"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={draft.mode === mode}
                    className={draft.mode === mode ? "active" : undefined}
                    onClick={() => setDraft({ ...draft, mode })}
                  >
                    {mode === "local" ? "Local test" : "Public"}
                  </button>
                ))}
              </div>
              <p className="pbx-hint">
                {draft.mode === "local"
                  ? "Testing on this network with phone apps. The phone provider and public address are switched off."
                  : "Live with a real phone number. The test phone is switched off."}
              </p>
            </div>

            {draft.mode === "local" && (
              <ol className="pbx-local-steps">
                <li>Install a phone app (Linphone, MicroSIP, Zoiper) on two devices on this network.</li>
                <li>Set a password for the <strong>Car IP phone</strong> and the <strong>Test phone</strong> below, tick <strong>Enable test phone</strong>, and press <strong>Save &amp; apply</strong>.</li>
                <li>
                  In each app add an account: server <code>{lanAddress ?? "this server's IP"}</code>, port <code>{SIP_PORT}</code>, transport <code>UDP</code>, username = extension
                  ({draft.phone.extension} for the car, {draft.test.extension} for the test phone), password as set below.
                </li>
                <li>Both should appear under <strong>Registered phones</strong> above (press Refresh).</li>
                <li>
                  From the test phone dial any number: it acts like calling the real phone number
                  {draft.menu.enabled && settings.menu.greeting ? " and plays the welcome menu" : " and rings the car"}.
                  From the car dial <code>{draft.test.extension}</code> to call the test phone{draft.party.enabled ? <>, or <code>88</code> for the party line</> : null}.
                </li>
              </ol>
            )}

            <div className="pbx-sections">
              <fieldset className="pbx-section" disabled={draft.mode === "local"}>
                <legend>Phone number provider{draft.mode === "local" && <span className="pbx-tag">Public only</span>}</legend>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.trunk.enabled} onChange={(e) => update("trunk", "enabled", e.target.checked)} />
                  Enable phone line
                </label>
                <label className="pbx-field">Server<input className="pbx-input" value={draft.trunk.host} onChange={(e) => update("trunk", "host", e.target.value)} placeholder="sip.provider.com" /></label>
                <label className="pbx-field">Port<input className="pbx-input" type="number" min={1} max={65535} value={draft.trunk.port} onChange={(e) => update("trunk", "port", Number(e.target.value))} /></label>
                <label className="pbx-field">Username<input className="pbx-input" value={draft.trunk.username} onChange={(e) => update("trunk", "username", e.target.value)} autoComplete="off" /></label>
                <label className="pbx-field">Password<input className="pbx-input" type="password" value={draft.trunk.password} onChange={(e) => update("trunk", "password", e.target.value)} placeholder={settings.trunk.passwordSet ? "Unchanged" : "Not set"} autoComplete="new-password" /></label>
                <label className="pbx-field">Phone number<input className="pbx-input" value={draft.trunk.number} onChange={(e) => update("trunk", "number", e.target.value)} placeholder="+27…" /></label>
              </fieldset>

              <fieldset className="pbx-section">
                <legend>Car IP phone</legend>
                <label className="pbx-field">Extension / username<input className="pbx-input" value={draft.phone.extension} onChange={(e) => update("phone", "extension", e.target.value)} inputMode="numeric" /></label>
                <label className="pbx-field">Password<input className="pbx-input" type="password" value={draft.phone.password} onChange={(e) => update("phone", "password", e.target.value)} placeholder={settings.phone.passwordSet ? "Unchanged" : "Not set (min. 12 characters)"} autoComplete="new-password" /></label>
                <p className="pbx-hint">Set the IP phone to register to this server on UDP port {SIP_PORT} with this extension and password.</p>
              </fieldset>

              <fieldset className="pbx-section" disabled={draft.mode === "public"}>
                <legend>Test phone{draft.mode === "public" && <span className="pbx-tag">Local only</span>}</legend>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.test.enabled} onChange={(e) => update("test", "enabled", e.target.checked)} />
                  Enable test phone
                </label>
                <label className="pbx-field">Extension / username<input className="pbx-input" value={draft.test.extension} onChange={(e) => update("test", "extension", e.target.value)} inputMode="numeric" /></label>
                <label className="pbx-field">Password<input className="pbx-input" type="password" value={draft.test.password} onChange={(e) => update("test", "password", e.target.value)} placeholder={settings.test.passwordSet ? "Unchanged" : "Not set (min. 12 characters)"} autoComplete="new-password" /></label>
                <p className="pbx-hint">Register a phone app (e.g. Linphone) with this extension. Dialing any number from it acts like calling the car&apos;s real phone number.</p>
              </fieldset>

              <fieldset className="pbx-section">
                <legend>Incoming calls</legend>
                <label className="pbx-field">Ring the car for (seconds)<input className="pbx-input" type="number" min={5} max={120} value={draft.inbound.ringSeconds} onChange={(e) => update("inbound", "ringSeconds", Number(e.target.value))} /></label>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.inbound.musicWhileRinging} onChange={(e) => update("inbound", "musicWhileRinging", e.target.checked)} />
                  Callers hear hold music instead of ringing
                </label>
              </fieldset>

              <fieldset className="pbx-section" disabled={draft.mode === "local"}>
                <legend>Network{draft.mode === "local" && <span className="pbx-tag">Public only</span>}</legend>
                <label className="pbx-field">Public IP or domain<input className="pbx-input" value={draft.network.externalAddress} onChange={(e) => update("network", "externalAddress", e.target.value)} placeholder="sip.yourdomain.com" /></label>
                <p className="pbx-hint">Needed when the server is behind a router. Admin → Overview lists the exact ports to forward.</p>
              </fieldset>

              <fieldset className="pbx-section">
                <legend>Welcome menu{draft.party.enabled && <span className="pbx-tag">Needed by party line</span>}</legend>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.menu.enabled} disabled={draft.party.enabled} onChange={(e) => update("menu", "enabled", e.target.checked)} />
                  Play a greeting and let callers choose
                </label>
                <input ref={greetingInputRef} id="greeting-file-input" type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a" hidden disabled={busy} onChange={(e) => uploadGreeting(e.target.files)} />
                <div className="pbx-greeting">
                  <span>{settings.menu.greeting ? settings.menu.greeting.name : "No greeting uploaded"}</span>
                  <label className={`routes-action-btn${busy ? " disabled" : ""}`} htmlFor="greeting-file-input">{settings.menu.greeting ? "Replace" : "Upload"}</label>
                  {settings.menu.greeting && <button className="reset-button" type="button" onClick={deleteGreeting} disabled={busy}>Remove</button>}
                </div>
                {draft.menu.enabled && !settings.menu.greeting && (
                  <p className="pbx-warning">
                    Upload a greeting: until then calls go straight to the car{draft.party.enabled ? " and nobody can reach the party line" : ""}.
                  </p>
                )}
                <p className="pbx-hint">
                  Record something like: &quot;Welcome to the Carbage Run team! Press 1 to talk to the car{draft.party.enabled ? ", or press 2 to join the party line" : ""}.&quot;
                </p>
                <p className="pbx-hint">
                  Only 1{draft.party.enabled ? " and 2 do" : " does"} something; other keys are ignored. No choice within 5 seconds plays the greeting once more, then the call ends.
                  Without a greeting, calls go straight to the car.
                </p>
              </fieldset>

              <fieldset className="pbx-section">
                <legend>Waiting in line</legend>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.queue.enabled} onChange={(e) => update("queue", "enabled", e.target.checked)} />
                  Callers wait in line while the car is busy
                </label>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.queue.announcePosition} disabled={!draft.queue.enabled} onChange={(e) => update("queue", "announcePosition", e.target.checked)} />
                  Tell callers their place in line
                </label>
                <label className="pbx-field">Give up after (seconds)<input className="pbx-input" type="number" min={30} max={1800} value={draft.queue.maxWaitSeconds} disabled={!draft.queue.enabled} onChange={(e) => update("queue", "maxWaitSeconds", Number(e.target.value))} /></label>
                <p className="pbx-hint">The car keeps ringing every few seconds until someone answers or the wait runs out.</p>
              </fieldset>

              <fieldset className="pbx-section">
                <legend>Party line</legend>
                <label className="pbx-check">
                  <input
                    type="checkbox"
                    checked={draft.party.enabled}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      setDraft({ ...draft, party: { ...draft.party, enabled }, menu: { ...draft.menu, enabled: enabled || draft.menu.enabled } });
                    }}
                  />
                  Enable the team party line (also turns on the welcome menu)
                </label>
                <label className="pbx-field">PIN for callers<input className="pbx-input" value={draft.party.pin} disabled={!draft.party.enabled} onChange={(e) => update("party", "pin", e.target.value)} inputMode="numeric" placeholder="Empty = anyone can join" autoComplete="off" /></label>
                <label className="pbx-field">Max people<input className="pbx-input" type="number" min={2} max={30} value={draft.party.maxMembers} disabled={!draft.party.enabled} onChange={(e) => update("party", "maxMembers", Number(e.target.value))} /></label>
                <label className="pbx-check">
                  <input type="checkbox" checked={draft.party.ringCar} disabled={!draft.party.enabled} onChange={(e) => update("party", "ringCar", e.target.checked)} />
                  Ring the car when someone joins
                </label>
                <p className="pbx-hint">Callers press 2 in the welcome menu. If the car isn&apos;t in yet, the car phone rings as &quot;Party line&quot; (at most once a minute); answer to join. The car can also dial 88 any time. *1 mutes, *2 leaves.</p>
              </fieldset>
            </div>
          </form>

          <section className="control-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Music on hold</p><h2>Hold music ({settings.moh.length})</h2></div>
              <input ref={fileInputRef} id="moh-file-input" type="file" accept="audio/*,.mp3,.wav,.ogg,.flac,.m4a" hidden disabled={busy} onChange={(e) => uploadMoh(e.target.files)} />
              <label className={`media-upload-button${busy ? " disabled" : ""}`} htmlFor="moh-file-input">Upload</label>
            </div>
            {settings.moh.length > 0 ? (
              <ul className="pbx-moh-list">
                {settings.moh.map((item) => (
                  <li key={item.file}>
                    <span>{item.name}</span>
                    <button className="reset-button" type="button" onClick={() => deleteMoh(item)} disabled={busy}>Delete</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="pbx-hint pbx-moh-empty">No hold music yet. Upload MP3, WAV, OGG, FLAC or M4A (max 50 MB); tracks play in random order.</p>
            )}
          </section>

          <section className="control-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Call history</p><h2>Calls ({calls.length})</h2></div>
              <button className="routes-action-btn" type="button" onClick={refreshStatus}>Refresh</button>
            </div>
            {calls.length > 0 ? (
              <div className="pbx-calls">
                {groupCalls(calls).map((year, yearIndex) => (
                  <details key={year.key} className="pbx-call-group" open={yearIndex === 0}>
                    <summary>{year.label}<span className="route-group-count">{year.items.length}</span></summary>
                    {year.months.map((month, monthIndex) => (
                      <details key={month.key} className="pbx-call-group" open={yearIndex === 0 && monthIndex === 0}>
                        <summary>{month.label}<span className="route-group-count">{month.items.length}</span></summary>
                        {month.days.map((day, dayIndex) => (
                          <details key={day.key} className="pbx-call-group" open={yearIndex === 0 && monthIndex === 0 && dayIndex === 0}>
                            <summary>{day.label}<span className="route-group-count">{day.items.length}</span></summary>
                            <table>
                              <thead><tr><th>Time</th><th>From</th><th>To</th><th>Result</th><th>Talk time</th></tr></thead>
                              <tbody>
                                {day.items.map((entry) => (
                                  <tr key={entry.id}>
                                    <td>{formatTime(entry.start)}</td>
                                    <td>{entry.direction === "in" ? "↓ " : ""}{entry.from}</td>
                                    <td>{entry.direction === "out" ? "↑ " : ""}{entry.to}</td>
                                    <td className={`pbx-result ${entry.result}`}>{RESULT_LABEL[entry.result]}</td>
                                    <td>{entry.talkSeconds > 0 ? formatDuration(entry.talkSeconds) : "–"}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </details>
                        ))}
                      </details>
                    ))}
                  </details>
                ))}
              </div>
            ) : (
              <p className="pbx-hint pbx-moh-empty">No calls yet. Calls appear here once Asterisk is connected.</p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
