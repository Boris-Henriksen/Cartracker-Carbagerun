"use client";

import { useEffect, useRef, useState } from "react";
import TopBar from "@/components/TopBar";
import type { MediaItem } from "@/lib/media";

const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const KEY_STORAGE = "cartracker-media-key";

type RequestError = Error & { status?: number };

function requestError(message: string, status: number): RequestError {
  return Object.assign(new Error(message), { status });
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function fetchMedia(): Promise<MediaItem[]> {
  const response = await fetch("/api/media", { cache: "no-store" });
  const data = await response.json();
  return data.items ?? [];
}

function errorMessage(responseText: string, fallback: string): string {
  try {
    return JSON.parse(responseText).error ?? fallback;
  } catch {
    return fallback;
  }
}

// XHR instead of fetch because fetch has no upload progress events.
function uploadFile(file: File, key: string, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    xhr.setRequestHeader("Authorization", `Bearer ${key}`);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      // A 413 from nginx is an HTML page, so it has no JSON error to show.
      const fallback = xhr.status === 413 ? "File is too large for the web server" : `Upload failed (${xhr.status})`;
      reject(requestError(errorMessage(xhr.responseText, fallback), xhr.status));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.send(file);
  });
}

export default function MediaPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [upload, setUpload] = useState<{ name: string; progress: number; index: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [viewing, setViewing] = useState<MediaItem | null>(null);
  // The verified code while edit mode is unlocked; kept for this browser tab only.
  const [editKey, setEditKey] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [dragging, setDragging] = useState(false);
  // dragenter/dragleave also fire for child elements, so count depth to know when the drag really left.
  const dragDepthRef = useRef(0);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetchMedia().then(setItems).catch(() => setMessage({ text: "Could not load the gallery", error: true }));
    // Older versions remembered the key permanently; edit mode now only lasts for the tab.
    localStorage.removeItem(KEY_STORAGE);
    const saved = sessionStorage.getItem(KEY_STORAGE);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after mount
    if (saved) setEditKey(saved);
  }, []);

  useEffect(() => {
    if (unlocking) codeInputRef.current?.focus();
  }, [unlocking]);

  useEffect(() => {
    if (!viewing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewing(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewing]);

  function lock(text?: string) {
    sessionStorage.removeItem(KEY_STORAGE);
    setEditKey(null);
    setUnlocking(false);
    if (text) setMessage({ text, error: true });
  }

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    const code = codeInputRef.current?.value ?? "";
    if (!code) return;
    const response = await fetch("/api/media/unlock", { method: "POST", headers: { Authorization: `Bearer ${code}` } });
    if (!response.ok) {
      setMessage({ text: errorMessage(await response.text(), "Unlock failed"), error: true });
      if (codeInputRef.current) codeInputRef.current.value = "";
      if (response.status === 403) setUnlocking(false);
      return;
    }
    sessionStorage.setItem(KEY_STORAGE, code);
    setEditKey(code);
    setUnlocking(false);
    setMessage(null);
  }

  async function handleFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0 || !editKey) return;

    setMessage(null);
    let uploaded = 0;
    const failures: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!ACCEPTED_TYPES.includes(file.type)) {
        failures.push(`${file.name}: unsupported file type`);
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        failures.push(`${file.name}: larger than 100 MB`);
        continue;
      }
      setUpload({ name: file.name, progress: 0, index: i + 1, total: files.length });
      try {
        await uploadFile(file, editKey, (progress) => setUpload({ name: file.name, progress, index: i + 1, total: files.length }));
        uploaded++;
      } catch (error) {
        const { message: text, status } = error as RequestError;
        if (status === 401 || status === 403) {
          setUpload(null);
          lock(text);
          setItems(await fetchMedia());
          return;
        }
        failures.push(`${file.name}: ${text}`);
      }
    }
    setUpload(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setItems(await fetchMedia());
    setMessage(
      failures.length > 0
        ? { text: `${uploaded} uploaded. ${failures.join(" · ")}`, error: true }
        : { text: `${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded`, error: false }
    );
  }

  async function deleteItem(item: MediaItem) {
    if (!editKey || !window.confirm(`Delete "${item.name}"?`)) return;
    const response = await fetch(`/api/media/${item.file}`, { method: "DELETE", headers: { Authorization: `Bearer ${editKey}` } });
    if (!response.ok) {
      const text = errorMessage(await response.text(), "Delete failed");
      if (response.status === 401 || response.status === 403) lock(text);
      else setMessage({ text, error: true });
      return;
    }
    setViewing(null);
    setItems(await fetchMedia());
  }

  const canDrop = editKey !== null && upload === null;
  const isFileDrag = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
  const dropHandlers = canDrop
    ? {
        onDragEnter: (event: React.DragEvent) => {
          if (!isFileDrag(event)) return;
          event.preventDefault();
          dragDepthRef.current++;
          setDragging(true);
        },
        onDragOver: (event: React.DragEvent) => {
          if (isFileDrag(event)) event.preventDefault();
        },
        onDragLeave: () => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragging(false);
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        },
      }
    : {};

  return (
    <main className="shell">
      <TopBar />

      <section className="intro">
        <div>
          <p className="eyebrow">Gallery</p>
          <h1>Photos &amp; videos.</h1>
        </div>
      </section>

      <section className={`media-panel${dragging ? " dragging" : ""}`} {...dropHandlers}>
        <input
          ref={fileInputRef}
          id="media-file-input"
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          multiple
          hidden
          disabled={!canDrop}
          onChange={(event) => handleFiles(event.target.files)}
        />
        <div className="panel-head">
          <div><p className="eyebrow">Media</p><h2>Gallery ({items.length})</h2></div>
          <div className="media-upload-controls">
            {editKey ? (
              <>
                <label className={`media-upload-button${canDrop ? "" : " disabled"}`} htmlFor="media-file-input">Upload</label>
                <button className="routes-action-btn" type="button" onClick={() => lock()} disabled={upload !== null}>Done</button>
              </>
            ) : unlocking ? (
              <form className="media-unlock-form" onSubmit={unlock}>
                <input ref={codeInputRef} className="media-key-input" type="password" placeholder="Code" aria-label="Edit code" autoComplete="off" />
                <button className="media-upload-button" type="submit">Unlock</button>
                <button className="routes-action-btn" type="button" onClick={() => setUnlocking(false)}>Cancel</button>
              </form>
            ) : (
              <button className="routes-action-btn" type="button" onClick={() => setUnlocking(true)}>Edit</button>
            )}
          </div>
        </div>

        {editKey && (
          <label htmlFor="media-file-input" className={`media-dropzone${dragging ? " active" : ""}${canDrop ? "" : " disabled"}`}>
            <span className="media-dropzone-icon" aria-hidden="true">↑</span>
            <strong>{dragging ? "Drop to upload" : "Drag photos & videos here"}</strong>
            <span>or click to choose · JPG, PNG, WebP, GIF, MP4, MOV, WebM · max 100 MB</span>
          </label>
        )}

        {upload && (
          <div className="media-progress">
            <div className="media-progress-label">
              Uploading {upload.index}/{upload.total}: {upload.name} · {Math.round(upload.progress * 100)}%
            </div>
            <div className="media-progress-track"><div className="media-progress-bar" style={{ width: `${upload.progress * 100}%` }} /></div>
          </div>
        )}
        {message && <div className={`media-message${message.error ? " error" : ""}`}>{message.text}</div>}

        {items.length > 0 ? (
          <div className="media-grid">
            {items.map((item) => (
              <div key={item.file} className="media-tile-wrap">
                <button type="button" className="media-tile" onClick={() => setViewing(item)} title={item.name}>
                  {item.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- served from our own API, not optimisable by next/image
                    <img src={`/api/media/${item.file}`} alt={item.name} loading="lazy" />
                  ) : (
                    <>
                      <video src={`/api/media/${item.file}#t=0.1`} preload="metadata" muted playsInline />
                      <span className="media-play" aria-hidden="true">▶</span>
                    </>
                  )}
                  <span className="media-tile-meta">{formatDate(item.uploadedAt)}</span>
                </button>
                {editKey && (
                  <button type="button" className="media-tile-delete" onClick={() => deleteItem(item)} aria-label={`Delete ${item.name}`} title="Delete">✕</button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="control-empty">
            <span className="map-empty-mark">IMG</span>
            <strong>No photos or videos yet</strong>
            <span>Press Edit and enter the code to upload JPG, PNG, WebP, GIF, MP4, MOV or WebM files up to 100 MB.</span>
          </div>
        )}
      </section>

      {viewing && (
        <div className="media-viewer" role="dialog" aria-modal="true" aria-label={viewing.name} onClick={() => setViewing(null)}>
          <div className="media-viewer-content" onClick={(event) => event.stopPropagation()}>
            {viewing.kind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element -- served from our own API, not optimisable by next/image
              <img src={`/api/media/${viewing.file}`} alt={viewing.name} />
            ) : (
              <video src={`/api/media/${viewing.file}`} controls autoPlay playsInline />
            )}
            <div className="media-viewer-bar">
              <span>{viewing.name} · {formatSize(viewing.size)} · {formatDate(viewing.uploadedAt)}</span>
              <div className="panel-actions">
                <a className="routes-action-btn" href={`/api/media/${viewing.file}`} download={viewing.name}>Download</a>
                {editKey && <button className="reset-button" type="button" onClick={() => deleteItem(viewing)}>Delete</button>}
                <button className="routes-action-btn" type="button" onClick={() => setViewing(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
