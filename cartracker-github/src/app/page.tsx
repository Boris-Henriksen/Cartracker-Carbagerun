"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { VehicleTrack, Route } from "@/lib/telemetry";
import TopBar, { useTheme } from "@/components/TopBar";

const VehicleMap = dynamic(() => import("@/components/VehicleMap"), { ssr: false });

const REFRESH_INTERVAL_SECONDS = 60;

// The GPS reports about once a minute; no report within this window means the car is off.
const REPORTING_WINDOW_MS = 5 * 60 * 1000;

const COMPASS_POINTS = ["NORTH", "NORTH EAST", "EAST", "SOUTH EAST", "SOUTH", "SOUTH WEST", "WEST", "NORTH WEST"];

function compassDirection(heading: number) {
  const normalized = ((heading % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 45) % 8];
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${meters.toFixed(0)} m`;
  }
  return `${(meters / 1000).toFixed(2)} km`;
}

// The MikroTik GPS reports speed in km/h, so it is stored and shown without conversion.
function formatSpeed(kmh: number): string {
  return `${kmh.toFixed(1)} km/h`;
}

function formatDuration(startTime: string, endTime: string): string {
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  const seconds = Math.round((end - start) / 1000);
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

function localDateKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

type RouteGroup = { key: string; label: string; routes: { route: Route; number: number }[] };

// Newest day first, newest route first within each day; routes are grouped by their start date.
function groupRoutesByDate(routes: Route[]): RouteGroup[] {
  const groups: RouteGroup[] = [];
  for (let i = routes.length - 1; i >= 0; i--) {
    const route = routes[i];
    const key = localDateKey(route.startTime);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      const [year, month, day] = key.split("-");
      group = { key, label: `${day}-${month}-${year}`, routes: [] };
      groups.push(group);
    }
    group.routes.push({ route, number: i + 1 });
  }
  return groups;
}

export default function Home() {
  const [vehicle, setVehicle] = useState<VehicleTrack | undefined>(undefined);
  const [status, setStatus] = useState("Connected");
  const [refreshInSeconds, setRefreshInSeconds] = useState(REFRESH_INTERVAL_SECONDS);
  const [now, setNow] = useState(() => Date.now());
  const theme = useTheme();
  const [selectedRoutes, setSelectedRoutes] = useState<Set<string>>(new Set());
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  const autoSelectedRouteRef = useRef<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<"selected" | "all" | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<{ text: string; error: boolean } | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const [carCall, setCarCall] = useState<"idle" | "ringing" | "on-call" | "unknown">("unknown");

  async function refresh() {
    fetch("/api/pbx/live", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => setCarCall(data.call ?? "unknown"))
      .catch(() => setCarCall("unknown"));
    try {
      const response = await fetch("/api/telemetry", { cache: "no-store" });
      const data = await response.json();
      const vehicles: VehicleTrack[] = data.vehicles ?? [];
      setVehicle(vehicles[0]);
      setStatus("Connected");
    } catch {
      setStatus("Offline");
    }
  }

  function startDelete(kind: "selected" | "all") {
    setDeleteMessage(null);
    setPendingDelete(kind);
  }

  async function submitDelete(event: React.FormEvent) {
    event.preventDefault();
    const code = codeInputRef.current?.value ?? "";
    if (!vehicle || !pendingDelete || !code) return;
    const ids = pendingDelete === "all" ? vehicle.routes.map((r) => r.id) : selectedRouteIds;
    if (ids.length === 0) return;

    const response = await fetch("/api/telemetry", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${code}`, "Content-Type": "application/json" },
      body: JSON.stringify(pendingDelete === "all" ? { vehicleId: vehicle.vehicleId, all: true } : { vehicleId: vehicle.vehicleId, routeIds: ids }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      setDeleteMessage({ text: data.error ?? `Delete failed (${response.status})`, error: true });
      if (codeInputRef.current) codeInputRef.current.value = "";
      // Only a wrong code allows another try; a lockout or server error closes the prompt.
      if (response.status !== 401) setPendingDelete(null);
      return;
    }

    const deleted = new Set(ids);
    const remaining = vehicle.routes.filter((r) => !deleted.has(r.id));
    // Don't auto-select the route that becomes the latest just because a newer one was deleted.
    autoSelectedRouteRef.current = remaining[remaining.length - 1]?.id ?? null;
    setSelectedRoutes((prev) => new Set([...prev].filter((id) => !deleted.has(id))));
    setPendingDelete(null);
    setDeleteMessage({ text: `${ids.length} ${ids.length === 1 ? "route" : "routes"} deleted`, error: false });
    await refresh();
  }

  function toggleRouteSelection(routeId: string) {
    const newSelected = new Set(selectedRoutes);
    if (newSelected.has(routeId)) {
      newSelected.delete(routeId);
    } else {
      newSelected.add(routeId);
    }
    setSelectedRoutes(newSelected);
  }

  function selectAllRoutes() {
    if (!vehicle) return;
    const allIds = new Set(vehicle.routes.map((r) => r.id));
    setSelectedRoutes(allIds);
  }

  function clearAllRoutes() {
    setSelectedRoutes(new Set());
  }

  function toggleDate(key: string) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const routeGroups = groupRoutesByDate(vehicle?.routes ?? []);
  const isReporting = vehicle !== undefined && now - Date.parse(vehicle.lastSeen) < REPORTING_WINDOW_MS;
  const lastSeenLabel = vehicle
    ? localDateKey(vehicle.lastSeen) === localDateKey(new Date(now).toISOString())
      ? formatTime(vehicle.lastSeen)
      : new Date(vehicle.lastSeen).toLocaleString(undefined, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";

  // Get routes to display on map
  const displayedRoutes = vehicle?.routes.filter((r) => selectedRoutes.has(r.id)) ?? [];
  const selectedRouteIds = displayedRoutes.map((r) => r.id);
  const selectedPoints = displayedRoutes.flatMap((r) => r.points);
  const selectedSummary = selectedPoints.length > 0 ? {
    averageSpeed: selectedPoints.reduce((sum, p) => sum + p.speed, 0) / selectedPoints.length,
    topSpeed: selectedPoints.reduce((max, p) => Math.max(max, p.speed), 0),
    totalDistance: displayedRoutes.reduce((sum, r) => sum + r.statistics.totalDistance, 0),
  } : null;

  // Select each newly appearing latest route once, so a user uncheck isn't overridden on refresh.
  useEffect(() => {
    const latestRoute = vehicle?.routes[vehicle.routes.length - 1];
    if (!latestRoute || autoSelectedRouteRef.current === latestRoute.id) return;
    autoSelectedRouteRef.current = latestRoute.id;
    setSelectedRoutes((prev) => new Set(prev).add(latestRoute.id));
    setExpandedDates((prev) => new Set(prev).add(localDateKey(latestRoute.startTime)));
  }, [vehicle]);

  useEffect(() => {
    if (pendingDelete) codeInputRef.current?.focus();
  }, [pendingDelete]);

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const clock = window.setInterval(() => {
      setNow(Date.now());
      setRefreshInSeconds((seconds) => {
        if (seconds <= 1) {
          refresh();
          return REFRESH_INTERVAL_SECONDS;
        }
        return seconds - 1;
      });
    }, 1000);
    return () => window.clearInterval(clock);
  }, []);

  return (
    <main className="shell">
      <TopBar>
        <div className="connection"><span className="status-dot" /> {status}</div>
      </TopBar>

      <section className="intro">
        <div>
          <p className="eyebrow">Live vehicle tracking</p>
          <h1>Track your vehicle.</h1>
        </div>
      </section>

      <section className="workspace">
        <div className="workspace-main">
          <div className="overview-row">
            <section className="stats-box" aria-label="Vehicle summary">
              <div><span>Status</span><strong className={isReporting ? "active" : undefined}>{vehicle ? (isReporting ? "Active" : "Parked") : "Waiting"}</strong></div>
              <div><span>Next update</span><strong>{refreshInSeconds}s</strong></div>
              <div><span>Route points</span><strong>{vehicle ? vehicle.track.length : 0}</strong></div>
              <div><span>Total routes</span><strong>{vehicle?.routes.length ?? 0}</strong></div>
            </section>

            <section className="vehicle-box">
              <div className="vehicle-box-head">
                <div><p className="eyebrow">Vehicle</p><h2>{vehicle?.vehicleId ?? "Not connected"}</h2></div>
                {vehicle && (
                  <span className={`online-label${isReporting ? "" : " parked"}`}>
                    {isReporting ? "Live report" : `Last seen ${lastSeenLabel}`}
                  </span>
                )}
              </div>
              {vehicle ? (
                <div className="vehicle-details">
                  <div><span>Current Speed</span><strong>{formatSpeed(vehicle.latest.speed)}</strong></div>
                  <div><span>Heading</span><strong>{compassDirection(vehicle.latest.heading)} · {vehicle.latest.heading.toFixed(0)}°</strong></div>
                  <div><span>Latitude</span><strong>{vehicle.latest.latitude.toFixed(5)}</strong></div>
                  <div><span>Longitude</span><strong>{vehicle.latest.longitude.toFixed(5)}</strong></div>
                  {vehicle.latest.altitude !== undefined && <div><span>Altitude</span><strong>{vehicle.latest.altitude.toFixed(1)} m</strong></div>}
                  {vehicle.latest.satellites !== undefined && <div><span>Satellites</span><strong>{vehicle.latest.satellites}</strong></div>}
                  {vehicle.latest.fixQuality !== undefined && <div><span>Fix quality</span><strong>{vehicle.latest.fixQuality}</strong></div>}
                  {vehicle.latest.accuracy !== undefined && <div><span>Accuracy (HDOP)</span><strong>{vehicle.latest.accuracy.toFixed(2)}</strong></div>}
                </div>
              ) : (
                <div className="vehicle-box-empty">No vehicle data yet.</div>
              )}
            </section>
          </div>

          <div className="map-panel">
            <div className="panel-head">
              <div><p className="eyebrow">Live map</p><h2>Vehicle route</h2></div>
              <div className="panel-actions">
                <span className={`live-pill${isReporting ? "" : " parked"}`}>{isReporting ? "LIVE" : "PARKED"}</span>
                {carCall === "on-call" && <span className="live-pill call">ON A CALL</span>}
                {carCall === "ringing" && <span className="live-pill call">PHONE RINGING</span>}
                {vehicle && !pendingDelete && (
                  <>
                    <button className="reset-button" type="button" onClick={() => startDelete("selected")} disabled={selectedRouteIds.length === 0}>
                      Delete selected ({selectedRouteIds.length})
                    </button>
                    <button className="reset-button" type="button" onClick={() => startDelete("all")} disabled={vehicle.routes.length === 0}>
                      Delete all
                    </button>
                  </>
                )}
              </div>
            </div>
            {vehicle && pendingDelete && (
              <form className="route-delete-form" onSubmit={submitDelete}>
                <span>
                  {pendingDelete === "all"
                    ? `Delete all ${vehicle.routes.length} routes?`
                    : `Delete ${selectedRouteIds.length} selected ${selectedRouteIds.length === 1 ? "route" : "routes"}?`}
                </span>
                <input ref={codeInputRef} className="media-key-input" type="password" placeholder="Code" aria-label="Delete code" autoComplete="off" />
                <button className="reset-button" type="submit">Delete</button>
                <button className="routes-action-btn" type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
              </form>
            )}
            {deleteMessage && <div className={`media-message${deleteMessage.error ? " error" : ""}`}>{deleteMessage.text}</div>}
            <div className="map-canvas">
              {vehicle ? <VehicleMap routes={displayedRoutes} latestPoint={vehicle.latest} theme={theme} /> : <div className="map-empty"><span className="map-empty-mark">GPS</span><strong>Waiting for a position</strong><span>Connect the tracker to start receiving location data.</span></div>}
            </div>
          </div>
        </div>

        <aside className="routes-panel">
          <div className="panel-head">
            <div><p className="eyebrow">Routes</p><h2>Routes ({vehicle?.routes.length ?? 0})</h2></div>
            {vehicle && (
              <div className="routes-actions">
                <button className="routes-action-btn" onClick={selectAllRoutes} title="Select all routes">All</button>
                <button className="routes-action-btn" onClick={clearAllRoutes} title="Clear selection">None</button>
              </div>
            )}
          </div>
          {vehicle ? (
            <>
              <div className="routes-section">
                <div className={`routes-summary${selectedSummary ? "" : " empty"}`}>
                  <div className="routes-summary-title">Selected ({displayedRoutes.length}) · {selectedPoints.length} points</div>
                  <div className="routes-summary-stats">
                    <span><small>Avg</small>{selectedSummary ? formatSpeed(selectedSummary.averageSpeed) : "–"}</span>
                    <span><small>Top</small>{selectedSummary ? formatSpeed(selectedSummary.topSpeed) : "–"}</span>
                    <span><small>Distance</small>{selectedSummary ? formatDistance(selectedSummary.totalDistance) : "–"}</span>
                  </div>
                </div>

                {vehicle.routes.length > 0 ? (
                  <div className="routes-table">
                    {routeGroups.map((group) => {
                      const isOpen = expandedDates.has(group.key);
                      const selectedInGroup = group.routes.filter(({ route }) => selectedRoutes.has(route.id)).length;
                      return (
                        <div key={group.key} className="route-group">
                          <button
                            type="button"
                            className="route-group-header"
                            aria-expanded={isOpen}
                            onClick={() => toggleDate(group.key)}
                          >
                            <span className="route-group-chevron" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                            <span className="route-group-date">{group.label}</span>
                            <span className="route-group-count" title="Selected / routes this day">{selectedInGroup}/{group.routes.length}</span>
                          </button>
                          {isOpen && (
                            <div className="route-group-items">
                              {group.routes.map(({ route, number: routeNumber }) => (
                                <div key={route.id} className="route-item" onClick={() => toggleRouteSelection(route.id)}>
                                  <div className="route-checkbox-col">
                                    <input
                                      type="checkbox"
                                      checked={selectedRoutes.has(route.id)}
                                      onChange={() => toggleRouteSelection(route.id)}
                                      onClick={(event) => event.stopPropagation()}
                                      aria-label={`Select route ${routeNumber}`}
                                    />
                                    <div
                                      className="route-color-indicator"
                                      style={{ backgroundColor: route.color }}
                                      title={`Route color: ${route.color}`}
                                    />
                                  </div>
                                  <div className="route-info">
                                    <div className="route-title">Route {routeNumber}</div>
                                    <div className="route-stats">
                                      <span>Top: {formatSpeed(route.statistics.topSpeed)}</span>
                                      <span>Avg: {formatSpeed(route.statistics.averageSpeed)}</span>
                                      <span>Distance: {formatDistance(route.statistics.totalDistance)}</span>
                                      <span>Duration: {formatDuration(route.startTime, route.endTime)}</span>
                                      <span>Points: {route.statistics.pointCount}</span>
                                    </div>
                                    <div className="route-time">
                                      {formatTime(route.startTime)} → {localDateKey(route.endTime) === group.key ? formatTime(route.endTime) : new Date(route.endTime).toLocaleString()}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="routes-empty">No routes yet. Start driving to record a route.</div>
                )}
              </div>
            </>
          ) : (
            <div className="empty-note">No vehicle data yet.</div>
          )}
        </aside>
      </section>
    </main>
  );
}

