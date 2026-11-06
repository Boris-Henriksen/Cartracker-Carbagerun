// Set by the installer (SIP_PORT); must match the firewall and router. Server-only: pages get it from the API.
export const SIP_PORT = Number(process.env.SIP_PORT) || 5060;
