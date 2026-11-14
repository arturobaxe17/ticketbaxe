import { supabase, supabasePublicKey, supabaseUrl } from './supabase';

export type ApiResult<T = any> = T & { ok: boolean };

async function parseResponse<T>(response: Response): Promise<ApiResult<T>> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Error ${response.status}`) as Error & { code?: string; status?: number };
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload as ApiResult<T>;
}

export async function portalApi<T = any>(action: string, body: Record<string, unknown> = {}, token?: string | null): Promise<ApiResult<T>> {
  if (!supabaseUrl || !supabasePublicKey) throw new Error('La aplicación todavía no está conectada a Supabase.');
  const response = await fetch(`${supabaseUrl}/functions/v1/portal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabasePublicKey,
      Authorization: `Bearer ${supabasePublicKey}`,
      ...(token ? { 'x-portal-session': token } : {}),
    },
    body: JSON.stringify({ action, ...body }),
  });
  return parseResponse<T>(response);
}

export async function adminApi<T = any>(action: string, body: Record<string, unknown> = {}): Promise<ApiResult<T>> {
  const { data, error } = await supabase.functions.invoke('admin', { body: { action, ...body } });
  if (error) {
    const detail = typeof data?.error === 'string' ? data.error : error.message;
    throw new Error(detail || 'No se pudo completar la operación.');
  }
  if (data?.ok === false) throw new Error(data.error || 'No se pudo completar la operación.');
  return data as ApiResult<T>;
}
