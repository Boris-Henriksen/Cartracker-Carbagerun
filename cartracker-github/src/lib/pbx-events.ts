import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { PARTY_CAR_CODE, amiCredentials, createAmiParser, effectiveSettings, readSettings, type AmiFields } from "@/lib/pbx";
import { DATA_DIR } from "@/lib/paths";

const CALLS_FILE = path.join(DATA_DIR, "pbx-calls.json");
const MAX_CALLS = 500;
const RECONNECT_MS = 10_000;

export type CarCallState = "idle" | "ringing" | "on-call" | "unknown";

export type CallLogEntry = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  start: string;
  result: "answered" | "missed" | "busy" | "failed" | "party";
  talkSeconds: number;
};

// A call in progress, keyed by Asterisk's Linkedid (shared by every channel of one call).
type ActiveCall = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  start: number;
  answeredAt?: number;
  party?: boolean;
  dialStatus?: string;
  // Channel prefixes that count as "the other side picked up" when they join a bridge.
  answerPrefixes: string[];
};

// instrumentation.ts and route handlers can get separate module copies, so share state through globalThis.
type LiveState = { started: boolean; connected: boolean; carState: CarCallState; calls: Map<string, ActiveCall> };
const globalKey = Symbol.for("cartracker.pbx.live");
const live: LiveState = ((globalThis as Record<symbol, LiveState>)[globalKey] ??= {
  started: false,
  connected: false,
  carState: "unknown",
  calls: new Map(),
});

export function carCallState(): CarCallState {
  return live.connected ? live.carState : "unknown";
}

export function readCallLog(): CallLogEntry[] {
  try {
    const entries = JSON.parse(fs.readFileSync(CALLS_FILE, "utf8")) as (CallLogEntry & { number?: string })[];
    // Entries written before From/To existed only have a single number.
    return entries.map(({ number, ...entry }) =>
      entry.from ? entry : { ...entry, from: entry.direction === "in" ? number ?? "" : "Car", to: entry.direction === "in" ? "Car" : number ?? "" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function writeCallLog(entries: CallLogEntry[]) {
  fs.mkdirSync(path.dirname(CALLS_FILE), { recursive: true });
  const tempFile = `${CALLS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(entries.slice(0, MAX_CALLS)));
  fs.renameSync(tempFile, CALLS_FILE);
}

function deviceState(state: string): CarCallState {
  if (state === "RINGING") return "ringing";
  if (["INUSE", "BUSY", "ONHOLD", "RINGINUSE"].includes(state)) return "on-call";
  return "idle";
}

// Asterisk's CDRs mark answered queue calls as "NO ANSWER", so calls are tracked from live events instead.
function startCall(event: AmiFields) {
  const settings = effectiveSettings(readSettings());
  const car = settings.phone.extension;
  const test = settings.test.enabled ? settings.test.extension : null;
  const channel = event.Channel ?? "";
  const carLabel = `Car (${car})`;
  const testLabel = `Test phone (${test})`;

  let call: Omit<ActiveCall, "id" | "start">;
  if (channel.startsWith("PJSIP/cartracker-trunk-")) {
    call = { direction: "in", from: event.CallerIDNum || "Unknown", to: carLabel, answerPrefixes: [`PJSIP/${car}-`] };
  } else if (test && channel.startsWith(`PJSIP/${test}-`)) {
    call = { direction: "in", from: testLabel, to: carLabel, answerPrefixes: [`PJSIP/${car}-`] };
  } else if (channel.startsWith(`PJSIP/${car}-`)) {
    const dialed = event.Exten ?? "";
    const to = dialed === PARTY_CAR_CODE ? "Party line" : dialed === test ? testLabel : dialed;
    call = { direction: "out", from: carLabel, to, answerPrefixes: ["PJSIP/cartracker-trunk-", ...(test ? [`PJSIP/${test}-`] : [])] };
  } else {
    return;
  }
  live.calls.set(event.Linkedid, { id: event.Linkedid, start: Date.now(), ...call });
}

function finishCall(call: ActiveCall) {
  live.calls.delete(call.id);
  const status = call.dialStatus ?? "";
  const result: CallLogEntry["result"] = call.party
    ? "party"
    : call.answeredAt
      ? "answered"
      : status === "BUSY"
        ? "busy"
        : call.direction === "out" && ["CHANUNAVAIL", "CONGESTION"].includes(status)
          ? "failed"
          : "missed";
  const entry: CallLogEntry = {
    id: call.id,
    direction: call.direction,
    from: call.from,
    to: call.party ? "Party line" : call.to,
    start: new Date(call.start).toISOString(),
    result,
    talkSeconds: call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0,
  };
  writeCallLog([entry, ...readCallLog()]);
}

function handleCallEvent(event: AmiFields) {
  if (event.Event === "Newchannel" && event.Uniqueid === event.Linkedid) return startCall(event);

  const call = event.Linkedid ? live.calls.get(event.Linkedid) : undefined;
  if (!call) return;
  const channel = event.Channel ?? "";
  switch (event.Event) {
    case "DialEnd":
      call.dialStatus = event.DialStatus;
      break;
    case "BridgeEnter":
      if (!call.answeredAt && call.answerPrefixes.some((prefix) => channel.startsWith(prefix))) call.answeredAt = Date.now();
      break;
    case "ConfbridgeJoin":
      call.party = true;
      call.answeredAt ??= Date.now();
      break;
    case "Hangup":
      // The call is over when the channel that started it hangs up.
      if (event.Uniqueid === call.id) finishCall(call);
      break;
  }
}

function connect() {
  const credentials = amiCredentials();
  if (!credentials) return;

  const socket = net.createConnection({ host: credentials.host, port: credentials.port });
  socket.setKeepAlive(true, 30_000);

  socket.on("connect", () => {
    socket.write(
      `Action: Login\r\nActionID: login\r\nUsername: ${credentials.user}\r\nSecret: ${credentials.secret}\r\nEvents: call\r\n\r\n` +
        "Action: DeviceStateList\r\nActionID: states\r\n\r\n"
    );
  });

  socket.on(
    "data",
    createAmiParser((fields) => {
      if (fields.ActionID === "login") {
        live.connected = fields.Response === "Success";
        // DeviceStateList only reports phones Asterisk knows, so start from idle.
        if (live.connected) live.carState = "idle";
        if (!live.connected) {
          console.error("PBX events: Asterisk rejected the AMI login");
          socket.end();
        }
        return;
      }
      try {
        if (fields.Event === "DeviceStateChange" && fields.Device === `PJSIP/${readSettings().phone.extension}`) {
          live.carState = deviceState(fields.State ?? "");
        } else {
          handleCallEvent(fields);
        }
      } catch (error) {
        console.error("PBX events:", error);
      }
    })
  );

  socket.on("error", () => {});
  socket.on("close", () => {
    live.connected = false;
    live.carState = "unknown";
    live.calls.clear();
    setTimeout(connect, RECONNECT_MS).unref();
  });
}

/** Keeps one AMI connection open for live call state and call history. */
export function startPbxEvents() {
  if (live.started || !amiCredentials()) return;
  live.started = true;
  connect();
}
