// Connection details for Supabase.
// The publishable key is safe to be public: security comes from the database rules (RLS).
// NEVER put the secret key (sb_secret_...) or the database password in this file.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://owiymgkqnpgkmpgfcnod.supabase.co";
const SUPABASE_KEY = "sb_publishable_wHDLlsC6PmpXalimr6xjyw_546NIhK3";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
