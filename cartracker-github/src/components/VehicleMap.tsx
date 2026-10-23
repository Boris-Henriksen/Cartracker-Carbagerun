"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Route, TelemetryPoint } from "@/lib/telemetry";

// Top-down cartoon car (blue wagon with a roof light bar), drawn facing "up" so
// heading 0 (north) needs no rotation; rotor div is turned to match true bearing.
const carSvg = `
<svg width="30" height="48" viewBox="0 0 30 48" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="15" cy="43" rx="10" ry="3" fill="#00000022" />
  <rect x="4" y="30" width="4" height="8" rx="1.5" fill="#20262b" />
  <rect x="22" y="30" width="4" height="8" rx="1.5" fill="#20262b" />
  <rect x="4" y="16" width="4" height="8" rx="1.5" fill="#20262b" />
  <rect x="22" y="16" width="4" height="8" rx="1.5" fill="#20262b" />
  <rect x="5" y="8" width="20" height="36" rx="7" fill="#2f63b8" stroke="#1b3d75" stroke-width="1.2" />
  <rect x="8" y="19" width="14" height="8" rx="3" fill="#9fc3f2" opacity="0.9" />
  <rect x="8" y="32" width="14" height="7" rx="3" fill="#9fc3f2" opacity="0.75" />
  <rect x="7.2" y="39" width="5.2" height="3.2" rx="1.1" fill="#631f24" stroke="#35171a" stroke-width="0.6" />
  <rect x="17.6" y="39" width="5.2" height="3.2" rx="1.1" fill="#631f24" stroke="#35171a" stroke-width="0.6" />
  <rect x="8" y="39.5" width="3.6" height="1.5" rx="0.75" fill="#ff4b4b" />
  <rect x="18.4" y="39.5" width="3.6" height="1.5" rx="0.75" fill="#ff4b4b" />
  <rect x="6.5" y="21" width="3.2" height="10" rx="1.2" fill="#1b3d75" />
  <rect x="20.3" y="21" width="3.2" height="10" rx="1.2" fill="#1b3d75" />
  <circle cx="9.5" cy="9.5" r="1.1" fill="#fff6d8" />
  <circle cx="20.5" cy="9.5" r="1.1" fill="#fff6d8" />
  <polygon points="15,8.2 17.2,10.6 12.8,10.6" fill="#f4f7ff" opacity="0.9" />
  <rect x="7" y="11" width="16" height="6" rx="2" fill="#22282e" />
  <circle cx="9" cy="14" r="1.2" fill="#f4f7ff" />
  <circle cx="13" cy="14" r="1.2" fill="#f4f7ff" />
  <circle cx="17" cy="14" r="1.2" fill="#f4f7ff" />
  <circle cx="21" cy="14" r="1.2" fill="#f4f7ff" />
  <rect x="8" y="27.5" width="14" height="4" rx="2" fill="#22282e" />
  <rect x="9.5" y="27.9" width="11" height="2.2" rx="1.1" fill="#ef8d34" stroke="#b5661a" stroke-width="0.6" />
  <rect x="10.5" y="28.1" width="9" height="0.7" rx="0.35" fill="#ffd18a" opacity="0.8" />
</svg>`;

const carIcon = L.divIcon({
  className: "map-car-icon",
  html: `<span class="map-car-pulse"></span><div class="map-car-rotor">${carSvg}</div>`,
  iconSize: [42, 42],
  iconAnchor: [21, 21],
});

const TILE_URLS = {
  dark: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  light: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
};

type VehicleMapProps = {
  routes: Route[];
  latestPoint?: TelemetryPoint;
  theme: "dark" | "light";
};

export default function VehicleMap({ routes, latestPoint, theme }: VehicleMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const polylinesRef = useRef<L.Polyline[]>([]);
  const markersRef = useRef<L.Marker[]>([]);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const hasFitRef = useRef(false);
  const initialThemeRef = useRef(theme);

  // Start point marker icon
  const startPointIcon = L.divIcon({
    className: "start-point-marker",
    html: `<div style="width: 12px; height: 12px; background: #00FF00; border: 2px solid #0066FF; border-radius: 50%; box-shadow: 0 0 8px rgba(0,255,0,0.6);"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });

  // Create the map once; later updates only move the marker/polyline instead of recreating it.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { zoom: 13, center: [0, 0] });
    map.attributionControl.setPrefix("");

    tileLayerRef.current = L.tileLayer(TILE_URLS[initialThemeRef.current], {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }).addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      polylinesRef.current = [];
      markersRef.current = [];
      tileLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    tileLayerRef.current?.setUrl(TILE_URLS[theme]);
  }, [theme]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear existing polylines and markers
    polylinesRef.current.forEach((polyline) => map.removeLayer(polyline));
    polylinesRef.current = [];
    markersRef.current.forEach((marker) => map.removeLayer(marker));
    markersRef.current = [];

    if (routes.length === 0) {
      markerRef.current?.remove();
      markerRef.current = null;
      hasFitRef.current = false;
      return;
    }

    // Add polylines for each route
    let allBounds: L.LatLngBounds | null = null;
    routes.forEach((route) => {
      if (route.points.length > 0) {
        const drawnPoints = route.connectedFrom ? [route.connectedFrom, ...route.points] : route.points;
        const latLngs = drawnPoints.map((point) => [point.latitude, point.longitude] as [number, number]);
        const polyline = L.polyline(latLngs, { color: route.color, weight: 4 }).addTo(map);
        polylinesRef.current.push(polyline);

        if (!allBounds) {
          allBounds = polyline.getBounds();
        } else {
          allBounds.extend(polyline.getBounds());
        }

        // Add start point marker for each route
        const startMarker = L.marker(latLngs[0], { icon: startPointIcon }).addTo(map);
        startMarker.bindPopup(`Route started: ${new Date(route.startTime).toLocaleString()}`);
        markersRef.current.push(startMarker);
      }
    });

    // Update car marker position
    if (latestPoint) {
      const latest: [number, number] = [latestPoint.latitude, latestPoint.longitude];
      if (!markerRef.current) {
        markerRef.current = L.marker(latest, { icon: carIcon }).addTo(map);
      } else {
        markerRef.current.setLatLng(latest);
      }

      const rotor = markerRef.current.getElement()?.querySelector<HTMLElement>(".map-car-rotor");
      if (rotor) rotor.style.transform = `rotate(${latestPoint.heading}deg)`;
    }

    // Fit bounds to all routes
    if (!hasFitRef.current && allBounds) {
      try {
        map.fitBounds(allBounds, { padding: [40, 40] });
        hasFitRef.current = true;
      } catch {
        // Invalid bounds, ignore
      }
    } else if (!hasFitRef.current && latestPoint) {
      map.setView([latestPoint.latitude, latestPoint.longitude], 15);
      hasFitRef.current = true;
    }
  }, [routes, latestPoint]);

  return <div ref={containerRef} className={`leaflet-canvas${theme === "dark" ? " dark-map" : ""}`} />;
}
