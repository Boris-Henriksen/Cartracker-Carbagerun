import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { DATA_DIR } from "@/lib/paths";
import { SIP_PORT } from "@/lib/pbx-constants";

const SETTINGS_FILE = path.join(DATA_DIR, "pbx.json");
// Asterisk has to read these, so the installer points them at directories the asterisk group can access.
export const ASTERISK_CONFIG_DIR = process.env.ASTERISK_CONFIG_DIR || path.join(DATA_DIR, "asterisk");
export const MOH_DIR = process.env.ASTERISK_MOH_DIR || path.join(DATA_DIR, "pbx", "moh");
export const SOUNDS_DIR = process.env.ASTERISK_SOUNDS_DIR || path.join(DATA_DIR, "pbx", "sounds");
export const GREETING_FILE = path.join(SOUNDS_DIR, "greeting.wav");

export const MOH_CLASS = "cartracker";
export const MAX_MOH_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MOH_FILE_PATTERN = /^\d+-[0-9a-f-]{36}\.wav$/;

// Declared type -> ffmpeg demuxer. Forcing the demuxer stops ffmpeg from probing playlist formats that can fetch URLs.
export const MOH_INPUT_TYPES: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "mov",
  "audio/x-m4a": "mov",
};

export type MohFile = { file: string; name: string; uploadedAt: string };

export type PbxSettings = {
  mode: "local" | "public";
  trunk: { enabled: boolean; host: string; port: number; username: string; password: string; number: string };
  phone: { extension: string; password: string };
  network: { externalAddress: string };
  inbound: { ringSeconds: number; musicWhileRinging: boolean };
  menu: { enabled: boolean; greeting: { name: string; uploadedAt: string } | null };
  queue: { enabled: boolean; announcePosition: boolean; maxWaitSeconds: number };
  party: { enabled: boolean; pin: string; maxMembers: number; ringCar: boolean };
  test: { enabled: boolean; extension: string; password: string };
  moh: MohFile[];
};

const DEFAULT_SETTINGS: PbxSettings = {
  mode: "local",
  trunk: { enabled: false, host: "", port: 5060, username: "", password: "", number: "" },
  phone: { extension: "100", password: "" },
  network: { externalAddress: "" },
  inbound: { ringSeconds: 30, musicWhileRinging: true },
  menu: { enabled: false, greeting: null },
  queue: { enabled: false, announcePosition: true, maxWaitSeconds: 300 },
  party: { enabled: false, pin: "", maxMembers: 10, ringCar: true },
  test: { enabled: false, extension: "200", password: "" },
  moh: [],
};

export function readSettings(): PbxSettings {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) as Partial<PbxSettings>;
    return {
      mode: saved.mode === "public" ? "public" : "local",
      trunk: { ...DEFAULT_SETTINGS.trunk, ...saved.trunk },
      phone: { ...DEFAULT_SETTINGS.phone, ...saved.phone },
      network: { ...DEFAULT_SETTINGS.network, ...saved.network },
      inbound: { ...DEFAULT_SETTINGS.inbound, ...saved.inbound },
      menu: { ...DEFAULT_SETTINGS.menu, ...saved.menu },
      queue: { ...DEFAULT_SETTINGS.queue, ...saved.queue },
      party: { ...DEFAULT_SETTINGS.party, ...saved.party },
      test: { ...DEFAULT_SETTINGS.test, ...saved.test },
      moh: saved.moh ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_SETTINGS);
    throw error;
  }
}

function writeFileAtomic(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.tmp`;
  fs.writeFileSync(tempFile, content, { mode: 0o640 });
  fs.renameSync(tempFile, file);
}

export function writeSettings(settings: PbxSettings) {
  writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Passwords never leave the server; the UI only learns whether one is set. */
export function publicSettings(settings: PbxSettings) {
  return {
    ...settings,
    trunk: { ...settings.trunk, password: "", passwordSet: settings.trunk.password.length > 0 },
    phone: { ...settings.phone, password: "", passwordSet: settings.phone.password.length > 0 },
    test: { ...settings.test, password: "", passwordSet: settings.test.password.length > 0 },
  };
}

export type PbxPublicSettings = ReturnType<typeof publicSettings>;

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_.+@-]{1,64}$/;
const NUMBER_PATTERN = /^\+?[0-9]{0,20}$/;
const EXTENSION_PATTERN = /^[0-9]{2,6}$/;

// Values end up in Asterisk config files, where ';' starts a comment and newlines start new options.
function isSafeSecret(value: string) {
  return /^[\x21-\x7e]{1,128}$/.test(value) && !/[;\\"']/.test(value);
}

type UpdateResult = { settings: PbxSettings } | { error: string };

export function applyUpdate(current: PbxSettings, body: unknown): UpdateResult {
  if (!body || typeof body !== "object") return { error: "Body must be a JSON object" };
  const input = body as Record<string, Record<string, unknown> | undefined>;
  const trunk = input.trunk ?? {};
  const phone = input.phone ?? {};
  const network = input.network ?? {};
  const inbound = input.inbound ?? {};
  const menu = input.menu ?? {};
  const queue = input.queue ?? {};
  const party = input.party ?? {};
  const test = input.test ?? {};
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

  const next: PbxSettings = {
    mode: (body as Record<string, unknown>).mode === "public" ? "public" : "local",
    trunk: {
      enabled: trunk.enabled === true,
      host: str(trunk.host),
      port: Number(trunk.port ?? 5060),
      username: str(trunk.username),
      password: str(trunk.password) || current.trunk.password,
      number: str(trunk.number),
    },
    phone: {
      extension: str(phone.extension),
      password: str(phone.password) || current.phone.password,
    },
    network: { externalAddress: str(network.externalAddress) },
    inbound: {
      ringSeconds: Number(inbound.ringSeconds ?? 30),
      musicWhileRinging: inbound.musicWhileRinging === true,
    },
    // Callers can only reach the party line through the menu, so it forces the menu on.
    menu: { enabled: menu.enabled === true || party.enabled === true, greeting: current.menu.greeting },
    queue: {
      enabled: queue.enabled === true,
      announcePosition: queue.announcePosition === true,
      maxWaitSeconds: Number(queue.maxWaitSeconds ?? 300),
    },
    party: {
      enabled: party.enabled === true,
      pin: str(party.pin),
      maxMembers: Number(party.maxMembers ?? 10),
      ringCar: party.ringCar === true,
    },
    test: {
      enabled: test.enabled === true,
      extension: str(test.extension),
      password: str(test.password) || current.test.password,
    },
    moh: current.moh,
  };

  if (next.trunk.host && !HOST_PATTERN.test(next.trunk.host)) return { error: "Provider server must be a hostname or IP, without port" };
  if (!Number.isInteger(next.trunk.port) || next.trunk.port < 1 || next.trunk.port > 65535) return { error: "Provider port must be 1-65535" };
  if (next.trunk.username && !USERNAME_PATTERN.test(next.trunk.username)) return { error: "Provider username has invalid characters" };
  if (str(trunk.password) && !isSafeSecret(next.trunk.password)) return { error: "Provider password can't contain spaces, quotes, ; or \\" };
  if (!NUMBER_PATTERN.test(next.trunk.number)) return { error: "Phone number may only contain digits and a leading +" };
  if (next.mode === "public" && next.trunk.enabled && (!next.trunk.host || !next.trunk.username || !next.trunk.password)) {
    return { error: "Provider server, username and password are required to enable the phone line" };
  }
  if (!EXTENSION_PATTERN.test(next.phone.extension)) return { error: "Car phone extension must be 2-6 digits" };
  if (str(phone.password) && (!isSafeSecret(next.phone.password) || next.phone.password.length < 12)) {
    return { error: "Car phone password must be at least 12 characters, without spaces, quotes, ; or \\" };
  }
  if (next.network.externalAddress && !HOST_PATTERN.test(next.network.externalAddress)) return { error: "Public address must be a hostname or IP" };
  if (!Number.isInteger(next.inbound.ringSeconds) || next.inbound.ringSeconds < 5 || next.inbound.ringSeconds > 120) {
    return { error: "Ring time must be 5-120 seconds" };
  }
  if (!Number.isInteger(next.queue.maxWaitSeconds) || next.queue.maxWaitSeconds < 30 || next.queue.maxWaitSeconds > 1800) {
    return { error: "Maximum wait in line must be 30-1800 seconds" };
  }
  if (next.party.pin && !/^[0-9]{4,8}$/.test(next.party.pin)) return { error: "Party line PIN must be 4-8 digits, or empty for no PIN" };
  if (!Number.isInteger(next.party.maxMembers) || next.party.maxMembers < 2 || next.party.maxMembers > 30) {
    return { error: "Party line size must be 2-30 people" };
  }
  if (!EXTENSION_PATTERN.test(next.test.extension)) return { error: "Test phone extension must be 2-6 digits" };
  if (next.test.extension === next.phone.extension) return { error: "Test phone and car phone need different extensions" };
  if (str(test.password) && (!isSafeSecret(next.test.password) || next.test.password.length < 12)) {
    return { error: "Test phone password must be at least 12 characters, without spaces, quotes, ; or \\" };
  }
  if (next.mode === "local" && next.test.enabled && !next.test.password) return { error: "Set a test phone password to enable it" };
  return { settings: next };
}

/** Options for the other mode are switched off but kept, so switching back restores them. */
export function effectiveSettings(s: PbxSettings): PbxSettings {
  return s.mode === "local"
    ? { ...s, trunk: { ...s.trunk, enabled: false }, network: { externalAddress: "" } }
    : { ...s, test: { ...s.test, enabled: false } };
}

// Skips Tailscale's 100.64.0.0/10 range so phones on the LAN get the address they can reach.
export function lanAddress(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) return address.address;
    }
  }
  return null;
}

function phoneEndpoint(ext: string, password: string, context: string, name: string): string[] {
  return [
    "",
    `[${ext}]`,
    "type=endpoint",
    "transport=cartracker-udp",
    `context=${context}`,
    "disallow=all",
    "allow=g722,ulaw,alaw",
    `auth=${ext}`,
    `aors=${ext}`,
    "direct_media=no",
    "rtp_symmetric=yes",
    "force_rport=yes",
    "rewrite_contact=yes",
    `moh_suggest=${MOH_CLASS}`,
    `callerid=${name} <${ext}>`,
    "",
    `[${ext}]`,
    "type=auth",
    "auth_type=userpass",
    `username=${ext}`,
    `password=${password}`,
    "",
    `[${ext}]`,
    "type=aor",
    "max_contacts=1",
    "remove_existing=yes",
    "qualify_frequency=30",
  ];
}

function pjsipConfig(s: PbxSettings): string {
  const lines = [
    "; Generated by CarTracker from the PBX tab. Manual changes will be overwritten.",
    "[cartracker-udp]",
    "type=transport",
    "protocol=udp",
    `bind=0.0.0.0:${SIP_PORT}`,
    "allow_reload=yes",
  ];
  if (s.network.externalAddress) {
    lines.push(
      `external_signaling_address=${s.network.externalAddress}`,
      `external_media_address=${s.network.externalAddress}`,
      "local_net=10.0.0.0/8",
      "local_net=172.16.0.0/12",
      "local_net=192.168.0.0/16",
      "local_net=127.0.0.0/8"
    );
  }

  if (s.phone.password) lines.push(...phoneEndpoint(s.phone.extension, s.phone.password, "cartracker-from-car", "Car"));
  if (s.test.enabled) lines.push(...phoneEndpoint(s.test.extension, s.test.password, "cartracker-test-caller", "Test caller"));

  if (s.trunk.enabled) {
    const { host, port, username, password } = s.trunk;
    const uri = `sip:${host}:${port}`;
    lines.push(
      "",
      "[cartracker-trunk-auth]",
      "type=auth",
      "auth_type=userpass",
      `username=${username}`,
      `password=${password}`,
      "",
      "[cartracker-trunk]",
      "type=registration",
      "transport=cartracker-udp",
      "outbound_auth=cartracker-trunk-auth",
      `server_uri=${uri}`,
      `client_uri=sip:${username}@${host}:${port}`,
      `contact_user=${username}`,
      "retry_interval=60",
      "forbidden_retry_interval=600",
      "expiration=3600",
      "line=yes",
      "endpoint=cartracker-trunk",
      "",
      "[cartracker-trunk]",
      "type=aor",
      `contact=${uri}`,
      "",
      "[cartracker-trunk]",
      "type=endpoint",
      "transport=cartracker-udp",
      "context=cartracker-inbound",
      "disallow=all",
      "allow=ulaw,alaw,g722",
      "outbound_auth=cartracker-trunk-auth",
      "aors=cartracker-trunk",
      `from_user=${username}`,
      `from_domain=${host}`,
      "direct_media=no",
      "rtp_symmetric=yes",
      "force_rport=yes",
      "rewrite_contact=yes",
      `moh_suggest=${MOH_CLASS}`,
      "",
      "[cartracker-trunk]",
      "type=identify",
      "endpoint=cartracker-trunk",
      `match=${host}`
    );
  }
  return `${lines.join("\n")}\n`;
}

export const QUEUE_NAME = "cartracker-car";
export const PARTY_ROOM = "cartracker-party";
// No star: the Poly drops '*' from dialed numbers.
export const PARTY_CAR_CODE = "88";

function extensionsConfig(s: PbxSettings): string {
  let ring = ["exten => s,1,Hangup()"];
  if (s.phone.password && s.queue.enabled) {
    // Queue option r rings instead of playing the queue's hold music.
    const options = s.inbound.musicWhileRinging ? "" : "r";
    ring = [`exten => s,1,Queue(${QUEUE_NAME},${options},,,${s.queue.maxWaitSeconds})`, " same => n,Hangup()"];
  } else if (s.phone.password) {
    const options = s.inbound.musicWhileRinging ? `m(${MOH_CLASS})` : "";
    ring = [`exten => s,1,Dial(PJSIP/${s.phone.extension},${s.inbound.ringSeconds},${options})`, " same => n,Hangup()"];
  }

  const main = s.menu.enabled && s.menu.greeting
    ? [
        "exten => s,1,Answer()",
        " same => n,Wait(1)",
        " same => n,Set(MENU_TRIES=0)",
        " same => n(menu),Set(MENU_TRIES=$[${MENU_TRIES} + 1])",
        ` same => n,Background(${GREETING_FILE.replace(/\.wav$/, "")})`,
        " same => n(wait),WaitExten(5)",
        "exten => 1,1,Goto(cartracker-ring,s,1)",
        ...(s.party.enabled ? ["exten => 2,1,Goto(cartracker-party,s,1)"] : []),
        "; No choice: play the greeting once more, then hang up.",
        "exten => t,1,GotoIf($[${MENU_TRIES} < 2]?s,menu)",
        " same => n,Hangup()",
        "; Other keys are ignored: keep waiting without replaying the greeting.",
        "exten => i,1,Goto(s,wait)",
      ]
    : ["exten => s,1,Goto(cartracker-ring,s,1)"];

  const joinParty = (profile: string) => `ConfBridge(${PARTY_ROOM},cartracker-bridge,${profile},cartracker-menu)`;
  // Rings the car through a Local channel so the phone shows "Party line"; answering joins the room.
  const ringCar = s.party.ringCar && s.phone.password
    ? [
        " same => n,GotoIf($[${CONFBRIDGE_INFO(marked," + PARTY_ROOM + ")} > 0]?join)",
        " same => n,Set(LAST=${GLOBAL(CT_PARTY_ALERT)})",
        ' same => n,ExecIf($["${LAST}" = ""]?Set(LAST=0))',
        " same => n,GotoIf($[${EPOCH} - ${LAST} < 60]?join)",
        " same => n,Set(GLOBAL(CT_PARTY_ALERT)=${EPOCH})",
        ` same => n,Originate(Local/ring@cartracker-party-alert,exten,cartracker-party-car,s,1,${s.inbound.ringSeconds + 5},a)`,
      ]
    : [];

  const party = s.party.enabled
    ? [
        "",
        "[cartracker-party]",
        "exten => s,1,Answer()",
        ...ringCar,
        ` same => n(join),${joinParty("cartracker-caller")}`,
        " same => n,Hangup()",
        "",
        "[cartracker-party-alert]",
        `exten => ring,1,Set(CALLERID(all)="Party line" <${PARTY_CAR_CODE}>)`,
        ` same => n,Dial(PJSIP/${s.phone.extension},${s.inbound.ringSeconds})`,
        " same => n,Hangup()",
        "",
        "[cartracker-party-car]",
        `exten => s,1,${joinParty("cartracker-car")}`,
        " same => n,Hangup()",
      ]
    : [];

  const outbound = (pattern: string) => [
    `exten => ${pattern},1,NoOp(Car calling \${EXTEN})`,
    ...(s.trunk.number ? [` same => n,Set(CALLERID(num)=${s.trunk.number})`] : []),
    " same => n,Dial(PJSIP/${EXTEN}@cartracker-trunk,120)",
    " same => n,Hangup()",
  ];

  return [
    "; Generated by CarTracker from the PBX tab. Manual changes will be overwritten.",
    "[cartracker-inbound]",
    "exten => s,1,Goto(cartracker-main,s,1)",
    "exten => _X.,1,Goto(cartracker-main,s,1)",
    "exten => _+X.,1,Goto(cartracker-main,s,1)",
    "",
    "[cartracker-main]",
    ...main,
    "",
    "[cartracker-ring]",
    ...ring,
    ...party,
    ...(s.test.enabled
      ? [
          "",
          "[cartracker-test-caller]",
          "; Any number dialed from the test phone acts like a call to the real phone number.",
          "exten => _X,1,Goto(cartracker-main,s,1)",
          "exten => _X.,1,Goto(cartracker-main,s,1)",
        ]
      : []),
    "",
    "[cartracker-from-car]",
    ...(s.test.enabled
      ? [
          "; Calling the test phone stands in for calling someone outside.",
          `exten => ${s.test.extension},1,Dial(PJSIP/${s.test.extension},${s.inbound.ringSeconds})`,
          " same => n,Hangup()",
        ]
      : []),
    ...(s.party.enabled
      ? [
          `exten => ${PARTY_CAR_CODE},1,Answer()`,
          ` same => n,${joinParty("cartracker-car")}`,
          " same => n,Hangup()",
        ]
      : []),
    ...(s.trunk.enabled ? [...outbound("_X."), ...outbound("_+X.")] : []),
    "",
  ].join("\n");
}

function mohConfig(): string {
  return [
    "; Generated by CarTracker from the PBX tab. Manual changes will be overwritten.",
    `[${MOH_CLASS}]`,
    "mode=files",
    `directory=${MOH_DIR}`,
    "sort=random",
    "",
  ].join("\n");
}

function queuesConfig(s: PbxSettings): string {
  return [
    "; Generated by CarTracker from the PBX tab. Manual changes will be overwritten.",
    `[${QUEUE_NAME}]`,
    "strategy=ringall",
    `timeout=${s.inbound.ringSeconds}`,
    "retry=3",
    "ringinuse=no",
    "joinempty=yes",
    "leavewhenempty=no",
    `musicclass=${MOH_CLASS}`,
    `announce-position=${s.queue.announcePosition ? "yes" : "no"}`,
    `announce-frequency=${s.queue.announcePosition ? 30 : 0}`,
    "announce-holdtime=no",
    ...(s.phone.password ? [`member => PJSIP/${s.phone.extension}`] : []),
    "",
  ].join("\n");
}

function confbridgeConfig(s: PbxSettings): string {
  const common = ["music_on_hold_when_empty=yes", `music_on_hold_class=${MOH_CLASS}`, "announce_user_count=yes", "dsp_drop_silence=yes"];
  return [
    "; Generated by CarTracker from the PBX tab. Manual changes will be overwritten.",
    "[cartracker-bridge]",
    "type=bridge",
    `max_members=${s.party.maxMembers}`,
    "",
    "[cartracker-caller]",
    "type=user",
    ...(s.party.pin ? [`pin=${s.party.pin}`] : []),
    ...common,
    "",
    "[cartracker-car]",
    "type=user",
    "admin=yes",
    "marked=yes",
    ...common,
    "",
    "[cartracker-menu]",
    "type=menu",
    "*1=toggle_mute",
    "*2=leave_conference",
    "",
  ].join("\n");
}

export function writeAsteriskConfig(stored: PbxSettings) {
  const settings = effectiveSettings(stored);
  writeFileAtomic(path.join(ASTERISK_CONFIG_DIR, "cartracker-pjsip.conf"), pjsipConfig(settings));
  writeFileAtomic(path.join(ASTERISK_CONFIG_DIR, "cartracker-extensions.conf"), extensionsConfig(settings));
  writeFileAtomic(path.join(ASTERISK_CONFIG_DIR, "cartracker-musiconhold.conf"), mohConfig());
  writeFileAtomic(path.join(ASTERISK_CONFIG_DIR, "cartracker-queues.conf"), queuesConfig(settings));
  writeFileAtomic(path.join(ASTERISK_CONFIG_DIR, "cartracker-confbridge.conf"), confbridgeConfig(settings));
}

export type AmiFields = Record<string, string> & { output: string };

export function amiCredentials() {
  const user = process.env.ASTERISK_AMI_USER;
  const secret = process.env.ASTERISK_AMI_SECRET;
  if (!user || !secret) return null;
  return { host: process.env.ASTERISK_AMI_HOST || "127.0.0.1", port: Number(process.env.ASTERISK_AMI_PORT || 5038), user, secret };
}

/** Splits the AMI stream into blank-line separated messages; repeated Output lines are joined. */
export function createAmiParser(onMessage: (fields: AmiFields) => void) {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let end: number;
    while ((end = buffer.indexOf("\r\n\r\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 4);
      const fields: AmiFields = { output: "" };
      const output: string[] = [];
      for (const line of block.split("\r\n")) {
        const sep = line.indexOf(": ");
        if (sep === -1) continue;
        const key = line.slice(0, sep);
        const value = line.slice(sep + 2);
        if (key === "Output") output.push(value);
        else fields[key] = value;
      }
      fields.output = output.join("\n");
      onMessage(fields);
    }
  };
}

// Short-lived AMI session: log in, run CLI commands, log off.
function amiCommands(commands: string[]): Promise<AmiFields[]> {
  const credentials = amiCredentials();
  if (!credentials) return Promise.reject(new Error("ASTERISK_AMI_USER / ASTERISK_AMI_SECRET are not set"));
  const { host, port, user, secret } = credentials;

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const responses = new Map<string, AmiFields>();
    let settled = false;

    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(commands.map((_, i) => responses.get(String(i))!));
    };

    socket.setTimeout(5000, () => finish(new Error("Asterisk did not respond")));
    socket.on("error", (error: NodeJS.ErrnoException) =>
      finish(new Error(error.code === "ECONNREFUSED" ? "Asterisk is not running (AMI connection refused)" : error.message))
    );

    socket.on(
      "data",
      createAmiParser((fields) => {
        if (!fields.ActionID) return;
        if (fields.ActionID === "login") {
          if (fields.Response !== "Success") finish(new Error("Asterisk rejected the AMI login"));
          return;
        }
        if (fields.Response === "Error") return finish(new Error(`Asterisk: ${fields.Message ?? "command failed"}`));
        responses.set(fields.ActionID, fields);
        if (responses.size === commands.length) {
          socket.write("Action: Logoff\r\n\r\n");
          finish(null);
        }
      })
    );

    socket.on("connect", () => {
      let message = `Action: Login\r\nActionID: login\r\nUsername: ${user}\r\nSecret: ${secret}\r\nEvents: off\r\n\r\n`;
      commands.forEach((command, i) => {
        message += `Action: Command\r\nActionID: ${i}\r\nCommand: ${command}\r\n\r\n`;
      });
      socket.write(message);
    });
  });
}

export type ApplyResult = { ok: true } | { ok: false; error: string };

export async function reloadAsterisk(): Promise<ApplyResult> {
  try {
    await amiCommands([
      "module reload res_pjsip.so",
      "dialplan reload",
      "moh reload",
      "module reload app_queue.so",
      "module reload app_confbridge.so",
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export type AsteriskStatus =
  | { connected: true; registrations: string; contacts: string }
  | { connected: false; error: string };

/** Version and the voice (RTP) port range Asterisk actually uses, or null when it can't be reached. */
export async function asteriskInfo(): Promise<{ version: string; rtpStart: number | null; rtpEnd: number | null } | null> {
  try {
    const [version, rtp] = await amiCommands(["core show version", "rtp show settings"]);
    const port = (label: string) => Number(new RegExp(`${label}:\\s*(\\d+)`, "i").exec(rtp.output)?.[1]) || null;
    return { version: version.output.trim().split("\n")[0].split(" built ")[0], rtpStart: port("Port start"), rtpEnd: port("Port end") };
  } catch {
    return null;
  }
}

export async function asteriskStatus(): Promise<AsteriskStatus> {
  try {
    const [registrations, contacts] = await amiCommands(["pjsip show registrations", "pjsip show contacts"]);
    return { connected: true, registrations: registrations.output, contacts: contacts.output };
  } catch (error) {
    return { connected: false, error: (error as Error).message };
  }
}

export function matchesAudioSignature(format: string, head: Buffer): boolean {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  switch (format) {
    case "mp3":
      return ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "ogg":
      return ascii(0, 4) === "OggS";
    case "flac":
      return ascii(0, 4) === "fLaC";
    case "mov":
      return ascii(4, 8) === "ftyp";
    default:
      return false;
  }
}

/** Converts to 8 kHz mono 16-bit WAV, the format Asterisk plays without transcoding. */
export function convertToMoh(input: string, format: string, output: string): Promise<void> {
  const args = [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
    "-protocol_whitelist", "file", "-f", format, "-i", input,
    "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", "-t", "3600", output,
  ];
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", args, { timeout: 120_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("ffmpeg is not installed on the server"));
      reject(new Error(stderr.trim().split("\n").pop() || "Could not convert the audio file"));
    });
  });
}

export type ReceiveResult = { ok: true; name: string } | { ok: false; error: string; status: number };

/** Streams a raw audio upload to a temp file, checks it, and converts it to `output`. */
export async function receiveAudio(request: Request, output: string): Promise<ReceiveResult> {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  const format = MOH_INPUT_TYPES[type];
  if (!format) return { ok: false, error: "Only MP3, WAV, OGG, FLAC and M4A files are allowed", status: 415 };
  if (Number(request.headers.get("content-length")) > MAX_MOH_UPLOAD_BYTES) return { ok: false, error: "File is larger than 50 MB", status: 413 };
  if (!request.body) return { ok: false, error: "Empty upload", status: 400 };

  let name = "audio";
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "").slice(0, 200) || name;
  } catch {
    // Keep the default name for malformed encodings.
  }

  const temp = path.join(os.tmpdir(), `cartracker-audio-${randomUUID()}`);
  let size = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > MAX_MOH_UPLOAD_BYTES ? new Error("too large") : null, chunk);
    },
  });

  try {
    try {
      await pipeline(Readable.fromWeb(request.body as unknown as NodeReadableStream), limiter, fs.createWriteStream(temp));
    } catch {
      const tooLarge = size > MAX_MOH_UPLOAD_BYTES;
      return { ok: false, error: tooLarge ? "File is larger than 50 MB" : "Upload was interrupted", status: tooLarge ? 413 : 400 };
    }

    const handle = await fs.promises.open(temp, "r");
    const head = Buffer.alloc(16);
    await handle.read(head, 0, 16, 0);
    await handle.close();
    if (size === 0 || !matchesAudioSignature(format, head)) return { ok: false, error: "File content doesn't match its type", status: 415 };

    // Convert next to the target, then rename, so a replaced file is never half-written.
    await fs.promises.mkdir(path.dirname(output), { recursive: true });
    const converted = `${output}.${randomUUID()}.wav`;
    try {
      await convertToMoh(temp, format, converted);
      await fs.promises.rename(converted, output);
    } catch (error) {
      await fs.promises.rm(converted, { force: true });
      return { ok: false, error: (error as Error).message, status: 422 };
    }
    return { ok: true, name };
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
}
