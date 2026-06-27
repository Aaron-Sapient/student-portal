import { createClient } from '@supabase/supabase-js';

/* Browser Supabase client for the STUDENT-HUBS project, keyed by the PUBLISHABLE
   key (sb_publishable_…, the going-forward replacement for the legacy anon key —
   maps to the `anon` role, safe to ship in client JS).

   Used ONLY for Realtime (Broadcast + Presence) to power live collaboration in the
   /write editor. It NEVER touches the writing tables — those are RLS-locked with no
   policies, and all persistence stays on the server via /api/writing/*. So this key
   grants nothing beyond joining a Realtime channel keyed by a doc UUID (possession
   of the link = capability, matching the existing share model).

   Distinct from lib/supabase.js, which is the SERVER-only service-role client. */

let _client = null;

export function getBrowserSupabase() {
  if (_client) return _client;
  if (typeof window === 'undefined') return null; // browser-only
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    console.warn(
      '[collab] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set — live collaboration disabled (editor still works solo + saves).'
    );
    return null;
  }
  _client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 25 } },
  });
  return _client;
}
