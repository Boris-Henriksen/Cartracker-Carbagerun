import type { Metadata } from "next";
import TopBar from "@/components/TopBar";

export const metadata: Metadata = {
  title: "Control",
};

export default function ControlPage() {
  return (
    <main className="shell">
      <TopBar />

      <section className="intro">
        <div>
          <p className="eyebrow">Vehicle control</p>
          <h1>Control your vehicle.</h1>
        </div>
      </section>

      <section className="control-panel">
        <div className="panel-head">
          <div><p className="eyebrow">Controls</p><h2>Available controls</h2></div>
        </div>
        <div className="control-empty">
          <span className="map-empty-mark">CTL</span>
          <strong>No controls configured yet</strong>
          <span>Interactive vehicle controls will appear here once they are connected.</span>
        </div>
      </section>
    </main>
  );
}
