import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/paths";

export type TelemetryPoint = {
  vehicleId: string;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number;
  timestamp: string;
  altitude?: number;
  satellites?: number;
  fixQuality?: number;
  accuracy?: number;
};

export type RouteStatistics = {
  topSpeed: number;
  averageSpeed: number;
  totalDistance: number;
  pointCount: number;
};

export type Route = {
  id: string;
  vehicleId: string;
  startTime: string;
  endTime: string;
  points: TelemetryPoint[];
  statistics: RouteStatistics;
  color: string;
  // Previous route's end point, drawn as the first vertex so nearby routes join up; excluded from statistics.
  connectedFrom?: TelemetryPoint;
};

export type VehicleTrack = {
  vehicleId: string;
  latest: TelemetryPoint;
  lastSeen: string;
  track: TelemetryPoint[];
  routes: Route[];
};

// Cap per-vehicle history so a forgotten device can't grow memory unbounded.
const MAX_TRACK_LENGTH = 5000;

// Points closer than this to the last recorded point count as parked (above typical GPS jitter),
// so a parked car's inactivity time keeps growing until it drives off and starts a new route.
const MIN_MOVE_METERS = 15;

// Time gap to trigger new route (2 hours in milliseconds)
const SIGNAL_LOSS_THRESHOLD = 2 * 60 * 60 * 1000;

// Join a new route to the previous one if it starts this close to where the last one ended,
// covering the distance driven between the last GPS report and parking (and after departure).
const CONNECT_ROUTES_MAX_METERS = 500;

// Colors for different routes
// The first eight are the original palette, kept first so existing routes keep their colors.
const ROUTE_COLORS = [
  "#ef8d56", "#4CAF50", "#2196F3", "#FF9800", "#9C27B0", "#F44336", "#00BCD4", "#FFEB3B",
  "#795548", // brown
  "#1B5E20", // dark green
  "#111111", // black
  "#E91E63", // pink
  "#BDBDBD", // light gray
  "#1A237E", // navy
  "#CDDC39", // lime
  "#555555", // dark gray
  "#800000", // maroon
  "#009688", // teal
  "#FFFFFF", // white
  "#673AB7", // deep purple
  "#808000", // olive
  "#81D4FA", // light blue
  "#FF80AB", // light pink
  "#3E2723", // dark brown
];

function distanceMeters(a: TelemetryPoint, b: TelemetryPoint) {
  const earthRadiusMeters = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.min(1, Math.sqrt(h)));
}

function calculateRouteStatistics(points: TelemetryPoint[]): RouteStatistics {
  if (points.length === 0) {
    return { topSpeed: 0, averageSpeed: 0, totalDistance: 0, pointCount: 0 };
  }

  let totalDistance = 0;
  for (let i = 1; i < points.length; i++) {
    totalDistance += distanceMeters(points[i - 1], points[i]);
  }

  const speeds = points.map((p) => p.speed).filter((s) => s >= 0);
  const topSpeed = speeds.length > 0 ? Math.max(...speeds) : 0;
  const averageSpeed = speeds.length > 0 ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

  return {
    topSpeed,
    averageSpeed,
    totalDistance,
    pointCount: points.length,
  };
}

function segmentRoutes(allPoints: TelemetryPoint[]): Route[] {
  if (allPoints.length === 0) return [];

  const routes: Route[] = [];
  let currentRoutePoints: TelemetryPoint[] = [allPoints[0]];
  let connectedFrom: TelemetryPoint | undefined;

  for (let i = 1; i < allPoints.length; i++) {
    const prev = allPoints[i - 1];
    const current = allPoints[i];
    const timeDiff = new Date(current.timestamp).getTime() - new Date(prev.timestamp).getTime();

    if (timeDiff > SIGNAL_LOSS_THRESHOLD) {
      // Create a new route
      const routeId = `${prev.vehicleId}-${new Date(currentRoutePoints[0].timestamp).getTime()}`;
      const color = ROUTE_COLORS[routes.length % ROUTE_COLORS.length];
      routes.push({
        id: routeId,
        vehicleId: prev.vehicleId,
        startTime: currentRoutePoints[0].timestamp,
        endTime: prev.timestamp,
        points: currentRoutePoints,
        statistics: calculateRouteStatistics(currentRoutePoints),
        color,
        connectedFrom,
      });

      // Start new route
      currentRoutePoints = [current];
      connectedFrom = distanceMeters(prev, current) <= CONNECT_ROUTES_MAX_METERS ? prev : undefined;
    } else {
      currentRoutePoints.push(current);
    }
  }

  // Add the current incomplete route
  if (currentRoutePoints.length > 0) {
    const routeId = `${currentRoutePoints[0].vehicleId}-${new Date(currentRoutePoints[0].timestamp).getTime()}`;
    const color = ROUTE_COLORS[routes.length % ROUTE_COLORS.length];
    routes.push({
      id: routeId,
      vehicleId: currentRoutePoints[0].vehicleId,
      startTime: currentRoutePoints[0].timestamp,
      endTime: currentRoutePoints[currentRoutePoints.length - 1].timestamp,
      points: currentRoutePoints,
      statistics: calculateRouteStatistics(currentRoutePoints),
      color,
      connectedFrom,
    });
  }

  return routes;
}

const globalStore = globalThis as typeof globalThis & {
  __carTrackerTracks?: Map<string, TelemetryPoint[]>;
};

export const TRACKS_FILE = process.env.TELEMETRY_DATA_FILE || path.join(DATA_DIR, "tracks.json");
const DATA_FILE = TRACKS_FILE;

function loadTracks(): Map<string, TelemetryPoint[]> {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Record<string, TelemetryPoint[]>;
    return new Map(Object.entries(saved));
  } catch (error) {
    // Only a missing file means "no data yet"; anything else must not be silently overwritten.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
}

function persistTracks() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(Object.fromEntries(tracks)));
  fs.renameSync(tempFile, DATA_FILE);
}

const tracks = globalStore.__carTrackerTracks ?? loadTracks();
globalStore.__carTrackerTracks = tracks;

// Last report per vehicle, including stationary points that aren't stored; in-memory only.
const lastSeen = new Map<string, string>();

export function getVehicleTracks(): VehicleTrack[] {
  return Array.from(tracks.entries())
    .map(([vehicleId, points]) => ({
      vehicleId,
      latest: points[points.length - 1],
      lastSeen: lastSeen.get(vehicleId) ?? points[points.length - 1].timestamp,
      track: points,
      routes: segmentRoutes(points),
    }))
    .sort((a, b) => b.latest.timestamp.localeCompare(a.latest.timestamp));
}

export function savePoint(point: TelemetryPoint) {
  const previousSeen = lastSeen.get(point.vehicleId);
  if (!previousSeen || Date.parse(point.timestamp) > Date.parse(previousSeen)) lastSeen.set(point.vehicleId, point.timestamp);

  const existing = tracks.get(point.vehicleId) ?? [];
  const last = existing[existing.length - 1];
  if (last && distanceMeters(last, point) < MIN_MOVE_METERS) {
    return last;
  }

  existing.push(point);
  if (existing.length > MAX_TRACK_LENGTH) {
    existing.splice(0, existing.length - MAX_TRACK_LENGTH);
  }
  tracks.set(point.vehicleId, existing);
  persistTracks();
  return point;
}

// Removes the points of the given routes; returns how many routes were deleted.
export function deleteRoutes(vehicleId: string, routeIds: string[]): number {
  const points = tracks.get(vehicleId);
  if (!points) return 0;
  const ids = new Set(routeIds);
  const doomedRoutes = segmentRoutes(points).filter((route) => ids.has(route.id));
  if (doomedRoutes.length === 0) return 0;

  const doomedPoints = new Set(doomedRoutes.flatMap((route) => route.points));
  const remaining = points.filter((point) => !doomedPoints.has(point));
  if (remaining.length === 0) {
    tracks.delete(vehicleId);
    lastSeen.delete(vehicleId);
  } else {
    tracks.set(vehicleId, remaining);
  }
  persistTracks();
  return doomedRoutes.length;
}

export function resetTrack(vehicleId?: string) {
  if (vehicleId) {
    tracks.delete(vehicleId);
    lastSeen.delete(vehicleId);
  } else {
    tracks.clear();
    lastSeen.clear();
  }
  persistTracks();
}
