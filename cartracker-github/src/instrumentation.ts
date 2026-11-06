export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startPbxEvents } = await import("@/lib/pbx-events");
    startPbxEvents();
  }
}
