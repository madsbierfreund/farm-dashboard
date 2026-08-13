'use server';

// Server-action som niveaumåleren kalder ved "Fyldt op". Den koerer på serveren
// og holder adgangen til databasen, så INGEST_TOKEN / service-role-noeglen aldrig
// naar ud i browseren (samme moenster som indstillingspanelet).

import { createClient } from '@supabase/supabase-js';

export async function recordRefill(volumeMl) {
  const volume = volumeMl == null ? 500 : Number(volumeMl);
  if (!Number.isFinite(volume) || volume <= 0 || volume > 20000) {
    return { ok: false, error: 'Volumen skal være et tal mellem 0 og 20000 ml.' };
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data, error } = await db
    .from('dose_refills')
    .insert({ volume_ml: volume, kind: 'ph_down' })
    .select()
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}
