import { createClient } from '@supabase/supabase-js';
import { getAppConfig } from './config';

// Proxy client for standard user queries (respects RLS)
export const supabase = new Proxy({} as any, {
  get(target, prop) {
    const config = getAppConfig();
    const client = createClient(config.supabaseUrl || 'https://placeholder.supabase.co', config.supabaseAnonKey || 'placeholder');
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});

// Proxy client for administrative server tasks (bypasses RLS during background syncs)
export const supabaseAdmin = new Proxy({} as any, {
  get(target, prop) {
    const config = getAppConfig();
    const client = createClient(
      config.supabaseUrl || 'https://placeholder.supabase.co', 
      config.supabaseServiceKey || 'placeholder', 
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      }
    );
    const value = (client as any)[prop];
    return typeof value === 'function' ? value.bind(client) : value;
  }
});
