"use client";

import { createContext, useContext, type ReactNode } from "react";

export type SiteInfo = { name: string; headline: string };

const SiteContext = createContext<SiteInfo>({ name: "CarTracker", headline: "Track your vehicle." });

export function SiteProvider({ value, children }: { value: SiteInfo; children: ReactNode }) {
  return <SiteContext.Provider value={value}>{children}</SiteContext.Provider>;
}

export function useSite(): SiteInfo {
  return useContext(SiteContext);
}

/** Up to two initials for the logo badge, e.g. "Carbage Run" -> "CR". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return letters.toUpperCase();
}
