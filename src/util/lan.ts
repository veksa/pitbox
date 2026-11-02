// The host's address on the local network, for devices that are not behind adb (phones on Wi-Fi, other hosts).

import os from 'node:os';

const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);

/** The first private IPv4 address, preferring home and office ranges; undefined when offline. */
export const lanAddress = (): string | undefined => {
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    // Virtual adapters (WSL, Hyper-V, Docker) are reachable from this host only.
    if (/vethernet|wsl|docker|virtualbox|vmware|hyper-v|loopback/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) candidates.push(a.address);
  }
  return candidates.sort((a, b) => rank(a) - rank(b))[0];
};
