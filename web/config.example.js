// Public browser config only. Supabase anon keys are designed to be public.
// NEVER put SUPABASE_SERVICE_ROLE_KEY or UPSTREAM_API_KEY in a browser file.
window.SHAOYONG_CONFIG = {
  SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  FREE_CHAT_URL: 'https://YOUR_PROJECT.supabase.co/functions/v1/free-chat',
  ALLOWED_ORIGIN: 'https://050121lxk.github.io',
  TURNSTILE_SITE_KEY: 'YOUR_PUBLIC_TURNSTILE_SITE_KEY',
};
