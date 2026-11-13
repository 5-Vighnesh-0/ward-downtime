// Toxiproxy in Docker between the app and the ward server (127.0.0.1:3101 → 3100), driven over its HTTP API.
import { execFileSync } from 'node:child_process';

const IMAGE = 'ghcr.io/shopify/toxiproxy:2.13.0@sha256:5d3dae09bc185dcc5ff6cf43abf6062a4a720aff0c4306a471e773acdcd107aa';
const API = 'http://127.0.0.1:8474';
const NAME = 'wdb-toxiproxy';

async function call(method: string, path: string, body?: object): Promise<Response> {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!res.ok && res.status !== 404) throw new Error(`toxiproxy ${method} ${path}: ${res.status} ${await res.text()}`);
  return res;
}

/** Global setup: start Toxiproxy (host network, localhost only) and create the `api` proxy. Returns the teardown. */
export default async function setup(): Promise<() => void> {
  execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  execFileSync('docker', ['run', '-d', '--rm', '--name', NAME, '--network', 'host', IMAGE, '-host', '127.0.0.1'], { stdio: 'ignore' });
  for (let i = 0; ; i++) {
    try {
      await call('GET', '/version');
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await call('POST', '/proxies', { name: 'api', listen: '127.0.0.1:3101', upstream: '127.0.0.1:3100' });
  return () => execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
}

export const addToxic = (name: string, type: string, stream: 'upstream' | 'downstream', attributes: Record<string, number>) =>
  call('POST', '/proxies/api/toxics', { name, type, stream, toxicity: 1, attributes });
export const removeToxic = (name: string) => call('DELETE', `/proxies/api/toxics/${name}`);
/** Removes every toxic (between tests). */
export const resetToxics = () => call('POST', '/reset');
