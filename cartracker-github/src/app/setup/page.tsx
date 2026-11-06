"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import MikrotikSetup, { type MikrotikChoice } from "@/components/MikrotikSetup";
import { initials, useSite } from "@/components/SiteContext";

const DRAFT_STORAGE = "cartracker-setup";
// Same key the admin pages use, so finishing setup leaves you logged in.
const ADMIN_KEY_STORAGE = "cartracker-media-key";

type Info = {
  install: { mode: "public" | "local"; domain: string | null; lanAddress: string | null; pbxInstalled: boolean; sipPort: number; rtpStart: number | null; rtpEnd: number | null };
  site: { name: string; headline: string; routeGapHours: number; minMoveMeters: number; maxPoints: number };
  security: { mode: "device" | "network"; maxAttempts: number; lockMinutes: number; networkMaxAttempts: number };
  pbx: { mode: "local" | "public"; extension: string; testExtension: string; externalAddress: string; trunk: { host: string; port: number; username: string; number: string } };
  mikrotik: { settings: MikrotikChoice; urls: { public: string | null; local: string | null }; token: string | null };
};

type StepId = "welcome" | "admin" | "site" | "tracking" | "mikrotik" | "phone" | "security" | "review";

type Draft = {
  skip: Partial<Record<StepId, boolean>>;
  site: { name: string; headline: string };
  tracking: { routeGapHours: number; minMoveMeters: number; maxPoints: number };
  mikrotik: MikrotikChoice & { installed: boolean };
  phone: {
    mode: "local" | "public";
    extension: string;
    testEnabled: boolean;
    testExtension: string;
    externalAddress: string;
    trunk: { enabled: boolean; host: string; port: number; username: string; number: string };
  };
  security: Info["security"];
};

// Never stored in the browser: re-entered after a page reload.
type Secrets = { adminCode: string; adminRepeat: string; phonePassword: string; testPassword: string; trunkPassword: string };

type TaskState = "pending" | "running" | "done" | "skipped" | "error";
type Task = { id: string; label: string; state: TaskState; message?: string; later?: string };

const STEP_TITLES: Record<StepId, string> = {
  welcome: "Welcome",
  admin: "Admin code",
  site: "Site",
  tracking: "Tracking",
  mikrotik: "Car (MikroTik)",
  phone: "Phone system",
  security: "Security",
  review: "Check & install",
};

// Where each skippable step can be configured after setup.
const LATER: Partial<Record<StepId, string>> = {
  site: "Admin \u2192 Site",
  tracking: "Admin \u2192 Site",
  mikrotik: "Admin \u2192 MikroTik",
  phone: "Admin \u2192 Phone (PBX)",
  security: "Admin \u2192 Security",
};

function draftFrom(info: Info): Draft {
  return {
    skip: {},
    site: { name: info.site.name, headline: info.site.headline },
    tracking: { routeGapHours: info.site.routeGapHours, minMoveMeters: info.site.minMoveMeters, maxPoints: info.site.maxPoints },
    mikrotik: { ...info.mikrotik.settings, installed: false },
    phone: {
      mode: info.install.mode,
      extension: info.pbx.extension,
      testEnabled: info.install.mode === "local",
      testExtension: info.pbx.testExtension,
      externalAddress: info.pbx.externalAddress,
      trunk: { enabled: false, host: info.pbx.trunk.host, port: info.pbx.trunk.port, username: info.pbx.trunk.username, number: info.pbx.trunk.number },
    },
    security: info.security,
  };
}

const safeSecret = (value: string) => value.length >= 12 && /^[\x21-\x7e]+$/.test(value) && !/[;\\"']/.test(value);

function validate(step: StepId, draft: Draft, secrets: Secrets): string | null {
  const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;
  switch (step) {
    case "admin":
      if (secrets.adminCode.length < 12) return "The admin code must be at least 12 characters.";
      if (secrets.adminCode.trim() !== secrets.adminCode) return "The admin code can't start or end with a space.";
      if (secrets.adminCode !== secrets.adminRepeat) return "The two codes don't match.";
      return null;
    case "site":
      if (!draft.site.name.trim() || draft.site.name.length > 40) return "Site name must be 1-40 characters.";
      if (!draft.site.headline.trim() || draft.site.headline.length > 80) return "Headline must be 1-80 characters.";
      return null;
    case "tracking":
      if (!between(draft.tracking.routeGapHours, 0.25, 48)) return "New route after must be 0.25-48 hours.";
      if (!between(draft.tracking.minMoveMeters, 0, 500)) return "Minimum movement must be 0-500 metres.";
      if (!Number.isInteger(draft.tracking.maxPoints) || !between(draft.tracking.maxPoints, 500, 100_000)) return "Max points must be 500-100000.";
      return null;
    case "mikrotik":
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(draft.mikrotik.vehicleId)) return "Vehicle name may only use letters, digits, - and _.";
      if (!Number.isInteger(draft.mikrotik.intervalSeconds) || !between(draft.mikrotik.intervalSeconds, 5, 3600)) return "Report interval must be 5-3600 seconds.";
      if (draft.mikrotik.localUrl && !/^https?:\/\/\S+$/.test(draft.mikrotik.localUrl)) return "The address must start with http:// or https://.";
      return null;
    case "phone": {
      const phone = draft.phone;
      if (!/^\d{2,6}$/.test(phone.extension)) return "Car phone extension must be 2-6 digits.";
      if (!safeSecret(secrets.phonePassword)) return "Car phone password: at least 12 characters, no spaces, quotes, ; or \\.";
      if (phone.mode === "local" && phone.testEnabled) {
        if (!/^\d{2,6}$/.test(phone.testExtension) || phone.testExtension === phone.extension) return "Test phone needs its own 2-6 digit extension.";
        if (!safeSecret(secrets.testPassword)) return "Test phone password: at least 12 characters, no spaces, quotes, ; or \\.";
      }
      if (phone.mode === "public" && phone.trunk.enabled && (!phone.trunk.host || !phone.trunk.username || !secrets.trunkPassword)) {
        return "Fill in the provider's server, username and password, or untick the phone number provider.";
      }
      return null;
    }
    case "security":
      if (!Number.isInteger(draft.security.maxAttempts) || !between(draft.security.maxAttempts, 3, 20)) return "Wrong codes before blocking must be 3-20.";
      if (!Number.isInteger(draft.security.lockMinutes) || !between(draft.security.lockMinutes, 1, 1440)) return "Block time must be 1-1440 minutes.";
      if (!Number.isInteger(draft.security.networkMaxAttempts) || !between(draft.security.networkMaxAttempts, 10, 500)) return "Network safety limit must be 10-500.";
      return null;
    default:
      return null;
  }
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, data };
}

export default function SetupPage() {
  const site = useSite();
  const router = useRouter();
  const [info, setInfo] = useState<Info | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secrets, setSecrets] = useState<Secrets>({ adminCode: "", adminRepeat: "", phonePassword: "", testPassword: "", trunkPassword: "" });
  const [stepIndex, setStepIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [finished, setFinished] = useState(false);
  const codeRef = useRef<HTMLInputElement | null>(null);

  const steps: StepId[] = ["welcome", "admin", "site", "tracking", "mikrotik", ...(info?.install.pbxInstalled ? (["phone"] as const) : []), "security", "review"];
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const percent = tasks ? 100 : Math.round((stepIndex / (steps.length - 1)) * 100);

  async function loadInfo(): Promise<boolean> {
    const response = await fetch("/api/setup", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!data.pending) {
      router.replace("/");
      return false;
    }
    if (!data.unlocked) return false;
    const loaded = data as Info;
    setInfo(loaded);
    const saved = sessionStorage.getItem(DRAFT_STORAGE);
    setDraft(saved ? (JSON.parse(saved) as Draft) : draftFrom(loaded));
    // Secrets aren't stored in the browser, so a reload continues from the admin code step.
    setStepIndex(1);
    return true;
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the setup state is only known after asking the server
    loadInfo().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);

  useEffect(() => {
    if (draft) sessionStorage.setItem(DRAFT_STORAGE, JSON.stringify(draft));
  }, [draft]);

  function update<K extends Exclude<keyof Draft, "skip">>(section: K, patch: Partial<Draft[K]>) {
    setDraft((current) => (current ? { ...current, [section]: { ...current[section], ...patch } } : current));
  }

  function setSkip(id: StepId, skip: boolean) {
    setDraft((current) => (current ? { ...current, skip: { ...current.skip, [id]: skip } } : current));
  }

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const code = codeRef.current?.value ?? "";
    if (!code.trim()) return;
    setError(null);
    const result = await post("/api/setup/unlock", { code });
    if (!result.ok) return setError((result.data.error as string) ?? "Could not unlock setup.");
    if (await loadInfo()) setStepIndex(1);
  }

  function next() {
    if (!draft) return;
    const problem = draft.skip[step] ? null : validate(step, draft, secrets);
    if (problem) return setError(problem);
    setError(null);
    setNotice(null);
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function back() {
    setError(null);
    setNotice(null);
    setStepIndex((index) => Math.max(index - 1, 1));
  }

  async function regenerateToken() {
    if (!window.confirm("Generate a new vehicle token? Any MikroTik already set up stops reporting until it gets the new script.")) return;
    const result = await post("/api/setup/apply", { step: "token" });
    if (!result.ok) return setError((result.data.error as string) ?? "Could not generate a token.");
    setInfo((current) => (current ? { ...current, mikrotik: { ...current.mikrotik, token: result.data.token as string } } : current));
    update("mikrotik", { installed: false });
  }

  function buildTasks(): (Task & { body?: Record<string, unknown> })[] {
    if (!draft || !info) return [];
    const skipped = (id: StepId) => Boolean(draft.skip[id]);
    const list: (Task & { body?: Record<string, unknown>; skip?: boolean })[] = [
      { id: "admin", label: "Saving the admin code", state: "pending", body: { code: secrets.adminCode } },
      { id: "site", label: "Site name and headline", state: "pending", body: draft.site, skip: skipped("site") },
      { id: "tracking", label: "Tracking settings", state: "pending", body: draft.tracking, skip: skipped("tracking") },
      {
        id: "mikrotik",
        label: "MikroTik settings",
        state: "pending",
        body: { connection: draft.mikrotik.connection, localUrl: draft.mikrotik.localUrl, vehicleId: draft.mikrotik.vehicleId, intervalSeconds: draft.mikrotik.intervalSeconds, installed: draft.mikrotik.installed },
        skip: skipped("mikrotik"),
      },
      ...(info.install.pbxInstalled
        ? [{
            id: "phone",
            label: "Phone system: writing config and reloading Asterisk",
            state: "pending" as TaskState,
            body: {
              ...draft.phone,
              password: secrets.phonePassword,
              testPassword: secrets.testPassword,
              trunk: { ...draft.phone.trunk, password: secrets.trunkPassword },
            },
            skip: skipped("phone"),
          }]
        : []),
      { id: "security", label: "Wrong-code protection", state: "pending", body: draft.security, skip: skipped("security") },
      { id: "check", label: "Checking everything works", state: "pending" },
    ];
    return list.map(({ skip, ...task }) => (skip ? { ...task, state: "skipped" as TaskState, later: LATER[task.id as StepId] } : task));
  }

  const taskBodies = useRef<Record<string, Record<string, unknown> | undefined>>({});

  async function runFrom(start: Task[]) {
    const list = [...start];
    for (let i = 0; i < list.length; i++) {
      if (list[i].state === "done" || list[i].state === "skipped") continue;
      list[i] = { ...list[i], state: "running", message: undefined };
      setTasks([...list]);
      const result = await post("/api/setup/apply", { step: list[i].id, data: taskBodies.current[list[i].id] });
      if (!result.ok) {
        list[i] = { ...list[i], state: "error", message: (result.data.error as string) ?? "Something went wrong." };
        setTasks([...list]);
        return;
      }
      list[i] = { ...list[i], state: "done" };
      setTasks([...list]);
    }
    const done = await post("/api/setup/apply", { step: "finish" });
    if (!done.ok) {
      setError((done.data.error as string) ?? "Could not finish setup.");
      return;
    }
    sessionStorage.removeItem(DRAFT_STORAGE);
    sessionStorage.setItem(ADMIN_KEY_STORAGE, secrets.adminCode);
    setFinished(true);
  }

  function install() {
    const list = buildTasks();
    taskBodies.current = Object.fromEntries(list.map((task) => [task.id, task.body]));
    const plain: Task[] = list.map(({ id, label, state, later }) => ({ id, label, state, later }));
    setTasks(plain);
    runFrom(plain);
  }

  function retry(index: number) {
    if (!tasks) return;
    runFrom(tasks.map((task, i) => (i === index ? { ...task, state: "pending" as TaskState, message: undefined } : task)));
  }

  function skipTask(index: number) {
    if (!tasks) return;
    const id = tasks[index].id as StepId;
    runFrom(tasks.map((task, i) => (i === index ? { ...task, state: "skipped" as TaskState, message: undefined, later: LATER[id] ?? "Admin \u2192 Overview" } : task)));
  }

  const progress = (
    <div className="setup-progress" aria-label={`Setup ${percent}% done`}>
      <div className="setup-progress-label">
        <span>{tasks ? (finished ? "Done" : "Installing") : `Step ${stepIndex + 1} of ${steps.length}: ${STEP_TITLES[step]}`}</span>
        <span>{percent}%</span>
      </div>
      <div className="setup-progress-track"><div className="setup-progress-bar" style={{ width: `${percent}%` }} /></div>
    </div>
  );

  const header = (
    <div className="setup-brand"><span className="brand-mark">{initials(site.name)}</span><span>{site.name} setup</span></div>
  );

  if (loading) return <main className="setup-shell">{header}<section className="setup-card"><p className="pbx-hint">Loading…</p></section></main>;

  // --- Install / progress screen ---
  if (tasks) {
    const handled = tasks.filter((task) => task.state === "done" || task.state === "skipped").length;
    const taskPercent = Math.round((handled / tasks.length) * 100);
    const failedIndex = tasks.findIndex((task) => task.state === "error");
    return (
      <main className="setup-shell">
        {header}
        <section className="setup-card">
          {progress}
          <h1>{finished ? "All set!" : "Setting everything up"}</h1>
          <div className="setup-progress">
            <div className="setup-progress-label"><span>{handled} of {tasks.length} steps</span><span>{taskPercent}%</span></div>
            <div className="setup-progress-track"><div className="setup-progress-bar" style={{ width: `${taskPercent}%` }} /></div>
          </div>
          <ul className="setup-tasks">
            {tasks.map((task, index) => (
              <li key={task.id} className={`setup-task ${task.state}`}>
                <span className="setup-task-icon" aria-hidden="true">
                  {task.state === "done" ? "\u2713" : task.state === "running" ? "\u27f3" : task.state === "error" ? "!" : task.state === "skipped" ? "\u2013" : "\u25cb"}
                </span>
                <div>
                  <strong>{task.label}</strong>
                  {task.state === "skipped" && <span className="pbx-hint">Skipped: configure later in {task.later}</span>}
                  {task.message && <span className="pbx-warning">{task.message}</span>}
                  {task.state === "error" && index === failedIndex && (
                    <span className="panel-actions">
                      <button className="media-upload-button" type="button" onClick={() => retry(index)}>Retry</button>
                      {task.id !== "admin" && <button className="routes-action-btn" type="button" onClick={() => skipTask(index)}>Skip, fix later</button>}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="pbx-warning">{error}</p>}
          {finished && (
            <div className="setup-actions">
              <span className="pbx-hint">Setup is closed. Everything can be changed later under Admin.</span>
              <button className="media-upload-button" type="button" onClick={() => router.push("/admin/overview")}>Open Admin</button>
            </div>
          )}
        </section>
      </main>
    );
  }

  // --- Step 1: setup code ---
  if (step === "welcome" || !info || !draft) {
    return (
      <main className="setup-shell">
        {header}
        <form className="setup-card" onSubmit={unlock}>
          {progress}
          <h1>Welcome</h1>
          <p className="setup-lead">A few questions and the site is ready. Each screen can be changed again later under Admin.</p>
          <label className="pbx-field">
            Setup code (shown in the terminal at the end of the install)
            <input ref={codeRef} className="pbx-input setup-code" placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoFocus spellCheck={false} />
          </label>
          {error && <p className="pbx-warning">{error}</p>}
          <div className="setup-actions">
            <span className="pbx-hint">Lost the code? On the server run <code>sudo bash deploy/install.sh --setup-code</code></span>
            <button className="media-upload-button" type="submit">Start</button>
          </div>
        </form>
      </main>
    );
  }

  const skippable = Boolean(LATER[step]);
  const skipped = Boolean(draft.skip[step]);

  return (
    <main className="setup-shell">
      {header}
      <form className="setup-card" onSubmit={(event) => { event.preventDefault(); if (step !== "review") next(); }}>
        {progress}
        <h1>{STEP_TITLES[step]}</h1>

        {skippable && (
          <label className="pbx-check setup-skip">
            <input type="checkbox" checked={skipped} onChange={(e) => setSkip(step, e.target.checked)} />
            Skip, configure later in {LATER[step]}
          </label>
        )}

        <fieldset className="setup-fields" disabled={skipped}>
          {step === "admin" && (
            <>
              <p className="setup-lead">This code unlocks the gallery uploads, route deletion and all admin pages. Share it only with the people who manage the site.</p>
              <label className="pbx-field">Admin code (min. 12 characters)<input className="pbx-input" type="password" autoComplete="new-password" autoFocus value={secrets.adminCode} onChange={(e) => setSecrets({ ...secrets, adminCode: e.target.value })} /></label>
              <label className="pbx-field">Repeat admin code<input className="pbx-input" type="password" autoComplete="new-password" value={secrets.adminRepeat} onChange={(e) => setSecrets({ ...secrets, adminRepeat: e.target.value })} /></label>
            </>
          )}

          {step === "site" && (
            <>
              <p className="setup-lead">What visitors see in the top bar, the browser tab and on the tracking page.</p>
              <label className="pbx-field">Site name<input className="pbx-input" maxLength={40} value={draft.site.name} onChange={(e) => update("site", { name: e.target.value })} /></label>
              <label className="pbx-field">Front page headline<input className="pbx-input" maxLength={80} value={draft.site.headline} onChange={(e) => update("site", { headline: e.target.value })} /></label>
            </>
          )}

          {step === "tracking" && (
            <>
              <p className="setup-lead">How positions from the car are turned into routes on the map.</p>
              <label className="pbx-field">Start a new route after (hours without signal)<input className="pbx-input" type="number" min={0.25} max={48} step={0.25} value={draft.tracking.routeGapHours} onChange={(e) => update("tracking", { routeGapHours: Number(e.target.value) })} /></label>
              <label className="pbx-field">Only save a point after moving (metres)<input className="pbx-input" type="number" min={0} max={500} value={draft.tracking.minMoveMeters} onChange={(e) => update("tracking", { minMoveMeters: Number(e.target.value) })} /></label>
              <label className="pbx-field">Keep at most (points per vehicle)<input className="pbx-input" type="number" min={500} max={100000} step={500} value={draft.tracking.maxPoints} onChange={(e) => update("tracking", { maxPoints: Number(e.target.value) })} /></label>
              <p className="pbx-hint">The movement limit filters GPS jitter while parked; the defaults suit most cars.</p>
            </>
          )}

          {step === "mikrotik" && (
            <>
              <p className="setup-lead">Copy the script below into the MikroTik in the car. It makes the router send its GPS position here.</p>
              <MikrotikSetup
                urls={info.mikrotik.urls}
                token={info.mikrotik.token}
                value={draft.mikrotik}
                onChange={(value) => update("mikrotik", { ...value, installed: false })}
                onMessage={(text, isError) => setNotice({ text, error: isError })}
              />
              {notice && <p className={notice.error ? "pbx-warning" : "pbx-hint"}>{notice.text}</p>}
              <label className="pbx-check">
                <input type="checkbox" checked={draft.mikrotik.installed} onChange={(e) => update("mikrotik", { installed: e.target.checked })} />
                I&apos;ve pasted this script on the MikroTik
              </label>
              <button className="reset-button setup-inline-button" type="button" onClick={regenerateToken}>Generate new vehicle token</button>
            </>
          )}

          {step === "phone" && (
            <>
              <p className="setup-lead">Callers reach the car through this server. Choose Local to test with phone apps on this network first.</p>
              <div className="pbx-mode" role="radiogroup" aria-label="Phone mode">
                {(["local", "public"] as const).map((mode) => (
                  <button key={mode} type="button" role="radio" aria-checked={draft.phone.mode === mode} className={draft.phone.mode === mode ? "active" : undefined} onClick={() => update("phone", { mode })}>
                    {mode === "local" ? "Local test" : "Public"}
                  </button>
                ))}
              </div>
              <div className="mikrotik-row">
                <label className="pbx-field">Car phone extension<input className="pbx-input" inputMode="numeric" value={draft.phone.extension} onChange={(e) => update("phone", { extension: e.target.value.trim() })} /></label>
                <label className="pbx-field">Car phone password<input className="pbx-input" type="password" autoComplete="new-password" value={secrets.phonePassword} onChange={(e) => setSecrets({ ...secrets, phonePassword: e.target.value })} /></label>
              </div>
              {draft.phone.mode === "local" ? (
                <>
                  <label className="pbx-check">
                    <input type="checkbox" checked={draft.phone.testEnabled} onChange={(e) => update("phone", { testEnabled: e.target.checked })} />
                    Add a test phone (acts like someone calling the car)
                  </label>
                  {draft.phone.testEnabled && (
                    <div className="mikrotik-row">
                      <label className="pbx-field">Test phone extension<input className="pbx-input" inputMode="numeric" value={draft.phone.testExtension} onChange={(e) => update("phone", { testExtension: e.target.value.trim() })} /></label>
                      <label className="pbx-field">Test phone password<input className="pbx-input" type="password" autoComplete="new-password" value={secrets.testPassword} onChange={(e) => setSecrets({ ...secrets, testPassword: e.target.value })} /></label>
                    </div>
                  )}
                  <p className="pbx-hint">Phone apps connect to <code>{info.install.lanAddress ?? "this server's IP"}</code>, UDP port <code>{info.install.sipPort}</code>.</p>
                </>
              ) : (
                <>
                  <label className="pbx-field">
                    Public address for calls
                    <input className="pbx-input" value={draft.phone.externalAddress} placeholder="sip.yourdomain.com" onChange={(e) => update("phone", { externalAddress: e.target.value.trim() })} />
                  </label>
                  <p className="pbx-hint">If your domain uses Cloudflare&apos;s proxy, use a separate name that isn&apos;t proxied, e.g. sip.yourdomain.com.</p>
                  <label className="pbx-check">
                    <input type="checkbox" checked={draft.phone.trunk.enabled} onChange={(e) => update("phone", { trunk: { ...draft.phone.trunk, enabled: e.target.checked } })} />
                    I have a phone number provider (otherwise add it later)
                  </label>
                  {draft.phone.trunk.enabled && (
                    <>
                      <div className="mikrotik-row">
                        <label className="pbx-field">Provider server<input className="pbx-input" value={draft.phone.trunk.host} placeholder="sip.provider.com" onChange={(e) => update("phone", { trunk: { ...draft.phone.trunk, host: e.target.value.trim() } })} /></label>
                        <label className="pbx-field">Port<input className="pbx-input" type="number" value={draft.phone.trunk.port} onChange={(e) => update("phone", { trunk: { ...draft.phone.trunk, port: Number(e.target.value) } })} /></label>
                      </div>
                      <div className="mikrotik-row">
                        <label className="pbx-field">Username<input className="pbx-input" value={draft.phone.trunk.username} onChange={(e) => update("phone", { trunk: { ...draft.phone.trunk, username: e.target.value.trim() } })} /></label>
                        <label className="pbx-field">Password<input className="pbx-input" type="password" autoComplete="new-password" value={secrets.trunkPassword} onChange={(e) => setSecrets({ ...secrets, trunkPassword: e.target.value })} /></label>
                      </div>
                      <label className="pbx-field">Phone number<input className="pbx-input" value={draft.phone.trunk.number} placeholder="+45…" onChange={(e) => update("phone", { trunk: { ...draft.phone.trunk, number: e.target.value.trim() } })} /></label>
                    </>
                  )}
                </>
              )}
              <p className="pbx-hint">Welcome menu, hold music, waiting line and party line are set up later under Admin &rarr; Phone (PBX).</p>
            </>
          )}

          {step === "security" && (
            <>
              <p className="setup-lead">What happens when someone types the admin code wrong too many times.</p>
              <div className="pbx-mode" role="radiogroup" aria-label="Block mode">
                {(["device", "network"] as const).map((mode) => (
                  <button key={mode} type="button" role="radio" aria-checked={draft.security.mode === mode} className={draft.security.mode === mode ? "active" : undefined} onClick={() => update("security", { mode })}>
                    {mode === "device" ? "Per device" : "Per network"}
                  </button>
                ))}
              </div>
              <p className="pbx-hint">
                {draft.security.mode === "device"
                  ? "Only the phone or browser typing wrong codes is blocked; others on the same network can still log in."
                  : "The whole network (public IP) is blocked, including everyone sharing it."}
              </p>
              <label className="pbx-field">Wrong codes before blocking<input className="pbx-input" type="number" min={3} max={20} value={draft.security.maxAttempts} onChange={(e) => update("security", { maxAttempts: Number(e.target.value) })} /></label>
              <label className="pbx-field">Block for (minutes)<input className="pbx-input" type="number" min={1} max={1440} value={draft.security.lockMinutes} onChange={(e) => update("security", { lockMinutes: Number(e.target.value) })} /></label>
              {draft.security.mode === "device" && (
                <label className="pbx-field">Network safety limit<input className="pbx-input" type="number" min={10} max={500} value={draft.security.networkMaxAttempts} onChange={(e) => update("security", { networkMaxAttempts: Number(e.target.value) })} /></label>
              )}
            </>
          )}

          {step === "review" && (
            <>
              <p className="setup-lead">Check your choices, then press Install. You can still go back.</p>
              <ul className="overview-list">
                <li><span>Admin code</span><span>{secrets.adminCode ? "Set" : "Missing: go back to Admin code"}</span></li>
                {(["site", "tracking", "mikrotik", ...(info.install.pbxInstalled ? ["phone"] : []), "security"] as StepId[]).map((id) => (
                  <li key={id}>
                    <span>{STEP_TITLES[id]}</span>
                    <span>
                      {draft.skip[id]
                        ? `Later in ${LATER[id]}`
                        : id === "site" ? draft.site.name
                        : id === "tracking" ? `${draft.tracking.routeGapHours} h \u00b7 ${draft.tracking.minMoveMeters} m`
                        : id === "mikrotik" ? `${draft.mikrotik.vehicleId}, every ${draft.mikrotik.intervalSeconds} s${draft.mikrotik.installed ? " \u00b7 installed" : ""}`
                        : id === "phone" ? `${draft.phone.mode === "local" ? "Local test" : "Public"} \u00b7 car ${draft.phone.extension}`
                        : `${draft.security.mode === "device" ? "Per device" : "Per network"}, ${draft.security.maxAttempts} tries`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="eyebrow setup-subhead">Still to do outside this server</p>
              <ul className="overview-list">
                {info.install.mode === "public" && info.install.domain && <li><span>DNS</span><span><code>{info.install.domain}</code> &rarr; your public IP</span></li>}
                {info.install.mode === "public" && <li><span>Router</span><span>TCP 80 + 443 &rarr; {info.install.lanAddress ?? "this server"}</span></li>}
                {info.install.pbxInstalled && (
                  <li>
                    <span>Router (calls)</span>
                    <span>UDP {info.install.sipPort}{info.install.rtpStart && info.install.rtpEnd ? ` + ${info.install.rtpStart}-${info.install.rtpEnd}` : ""} &rarr; {info.install.lanAddress ?? "this server"}</span>
                  </li>
                )}
                {info.install.mode === "local" && !info.install.pbxInstalled && <li><span>Nothing</span><span>Local install: no router changes needed</span></li>}
              </ul>
            </>
          )}
        </fieldset>

        {error && <p className="pbx-warning">{error}</p>}

        <div className="setup-actions">
          <button className="routes-action-btn" type="button" onClick={back} disabled={stepIndex <= 1}>Back</button>
          {step === "review" ? (
            <button className="media-upload-button" type="button" disabled={!secrets.adminCode} onClick={install}>Install</button>
          ) : (
            <button className="media-upload-button" type="submit">{skipped ? "Skip" : "Next"}</button>
          )}
        </div>
      </form>
    </main>
  );
}
