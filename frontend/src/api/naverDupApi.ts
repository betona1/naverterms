import axios from 'axios';

const api = axios.create({ baseURL: '/api/smartstore/naver-dup' });

export type Criterion = 'name' | 'image' | 'detail';
export type Strength = 'exact' | 'token';
export type StrengthFilter = 'all' | Strength;

export interface DupItem {
  id: number;
  folder_id: number;
  folder_name: string;
  product_code: string;
  product_name: string;
  naver_product_name?: string | null;
  image_large: string | null;
  market_price: number;
  sale_status?: string | null;
  match_count: number;
  twin_codes: string[];
  strength: Strength;
  score: number;
  group_key?: string | null;
}

export interface DupResponse {
  items: DupItem[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

const PATHS: Record<Criterion, string> = {
  name: '/by-name/',
  image: '/by-image/',
  detail: '/by-detail/',
};

export async function fetchDup(
  criterion: Criterion,
  page = 1,
  perPage = 50,
  opts: { refresh?: boolean; strength?: StrengthFilter; folderId?: number | null; excludeFolderId?: number | null } = {},
): Promise<DupResponse> {
  const params: Record<string, string | number> = { page, per_page: perPage };
  if (opts.refresh) params.refresh = '1';
  if (opts.strength && opts.strength !== 'all') params.strength = opts.strength;
  if (opts.folderId != null) params.folder_id = opts.folderId;
  if (opts.excludeFolderId != null) params.exclude_folder_id = opts.excludeFolderId;
  const res = await api.get(PATHS[criterion], { params });
  return res.data;
}

export async function markOrDelete(
  ids: number[],
  action: 'mark' | 'delete' | 'dismiss' | 'undismiss',
  mode?: 'name' | 'image' | 'detail' | 'all',
) {
  const res = await api.post('/mark/', { ids, action, mode });
  return res.data;
}

export async function fetchGroup(groupKey: string, mode: Criterion, folderId?: number | null) {
  const params: Record<string, string | number> = { group_key: groupKey, mode };
  if (folderId != null) params.folder_id = folderId;
  const res = await api.get<{ items: DupItem[] }>('/group/', { params });
  return res.data;
}
