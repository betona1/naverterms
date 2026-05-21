import axios from 'axios';

const api = axios.create({ baseURL: '/api/power' });

export interface PowerHost {
  key: string;
  name: string;
  ip: string;
  os: 'linux' | 'windows' | string;
  has_mac: boolean;
  wol_enabled: boolean;
  shutdown_enabled: boolean;
  note: string;
}

export interface PowerGroup {
  key: string;
  label: string;
  icon: string;
  hosts: PowerHost[];
}

export interface PowerStatusRow {
  key: string;
  name: string;
  ip: string;
  mac: string | null;
  group: string;
  os: string;
  alive: boolean;
  wol_ui: boolean;
  shutdown_ui: boolean;
  note: string;
}

export async function fetchPowerWorkers(): Promise<{ groups: PowerGroup[] }> {
  const r = await api.get('/workers/');
  return r.data;
}

export async function fetchPowerStatus(): Promise<{ hosts: PowerStatusRow[] }> {
  const r = await api.get('/status/');
  return r.data;
}

export async function powerWake(key: string): Promise<{ ok: boolean; mac?: string; sent_packets?: number; error?: string }> {
  const r = await api.post('/wake/', { key });
  return r.data;
}

export async function powerShutdown(key: string): Promise<{ ok: boolean; error?: string; body?: string }> {
  const r = await api.post('/shutdown/', { key });
  return r.data;
}
