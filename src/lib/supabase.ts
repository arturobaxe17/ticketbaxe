import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || 'https://tbqokrqeznaxepxcjrvg.supabase.co';
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'sb_publishable_SgBI5XA9TELRTXuxji8gGg_TFMEW_uT';

export const hasSupabaseConfig = Boolean(url && key && !url.includes('TU-PROYECTO'));
export const supabase = createClient(
  url,
  key,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
export const supabaseUrl = url;
export const supabasePublicKey = key;
