'use server';

// Server-action som doseringspanelet kalder ved gem. Den koerer på serveren og
// holder adgangen til databasen (og dermed hemmelighederne) — INGEST_TOKEN og
// service-role-noeglen naar aldrig ud i browseren.

import { createClient } from '@supabase/supabase-js';
import { validateSettings } from './settingsSchema';

export async function saveSettings(input) {
  const result = validateSettings(input);
  if (!result.ok) return { ok: false, error: result.error };

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await db
    .from('doser_settings')
    .update({ ...result.values, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}
