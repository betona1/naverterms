import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore' });

export interface WcodeBlacklistItem {
  product_code: string;
  reason: string | null;
  source: string;
  is_processed: boolean;
  processed_at: string | null;
  matched_my: boolean;
  matched_pre: boolean;
  matched_oc: boolean;
  matched_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WcodeBlacklistListResp {
  items: WcodeBlacklistItem[];
  total: number;
  page: number;
  per_page: number;
}

export async function fetchWcodeBlacklist(opts: {
  search?: string;
  only_unprocessed?: boolean;
  page?: number;
  per_page?: number;
} = {}): Promise<WcodeBlacklistListResp> {
  const params: Record<string, string | number> = {
    page: opts.page ?? 1,
    per_page: opts.per_page ?? 100,
  };
  if (opts.search) params.search = opts.search;
  if (opts.only_unprocessed) params.only_unprocessed = '1';
  const r = await api.get('/wcode-blacklist/', { params });
  return r.data;
}

export async function upsertWcodeBlacklist(
  codes: string, reason?: string,
): Promise<{
  ok: boolean; inserted: number; filled: number; unchanged: number;
  total: number; error?: string;
}> {
  const r = await api.post('/wcode-blacklist/', { codes, reason: reason || null },
    { validateStatus: () => true });
  return r.data;
}

export async function uploadWcodeBlacklistExcel(
  file: File, reason?: string,
): Promise<{
  ok: boolean; inserted?: number; filled?: number; unchanged?: number;
  parsed?: number; with_reason?: number; error?: string;
}> {
  const form = new FormData();
  form.append('file', file);
  if (reason) form.append('reason', reason);
  const r = await api.post('/wcode-blacklist/upload-excel/', form, {
    validateStatus: () => true,
  });
  return r.data;
}

export async function deleteWcodeBlacklist(codes: string[]): Promise<{ ok: boolean; deleted: number }> {
  const r = await api.delete('/wcode-blacklist/', {
    params: { codes: codes.join(',') },
  });
  return r.data;
}

export interface BlacklistMatchRow {
  id: number;
  product_code: string;
  product_name?: string | null;
  market_product_name?: string | null;
  naver_product_name?: string | null;
  category_name?: string | null;
  brand?: string | null;
  image_small?: string | null;
  sale_status?: string | number | null;
  is_synced?: number | null;
  folder_id?: number | null;
  seller_code1?: string | null;
  supplier_code?: string | null;
  ownerclan_price?: number | null;
  market_price?: number | null;
  updated_at?: string | null;
}

export interface WcodeBlacklistMatchResp {
  ok: boolean;
  total_codes: number;
  my: { count: number; items: BlacklistMatchRow[] };
  preliminary: { count: number; items: BlacklistMatchRow[] };
  ownerclan: { count: number; items: BlacklistMatchRow[] };
}

export async function matchWcodeBlacklist(refresh = true): Promise<WcodeBlacklistMatchResp> {
  if (refresh) {
    const r = await api.post('/wcode-blacklist/match/');
    return r.data;
  }
  const r = await api.get('/wcode-blacklist/match/');
  return r.data;
}

export async function processWcodeBlacklist(
  codes: string[], targets: Array<'my' | 'pre' | 'oc'>,
): Promise<{ ok: boolean; deleted: { my: number; pre: number; oc: number }; processed: number; targets: string[]; error?: string }> {
  const r = await api.post('/wcode-blacklist/process/',
    { codes, targets }, { validateStatus: () => true });
  return r.data;
}

export async function enforceWcodeBlacklist(): Promise<{
  ok: boolean;
  deleted: { my: number; pre: number; oc: number };
  total_codes: number;
  error?: string;
}> {
  const r = await api.post('/wcode-blacklist/enforce/',
    {}, { validateStatus: () => true });
  return r.data;
}
