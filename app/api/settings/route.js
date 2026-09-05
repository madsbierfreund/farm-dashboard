import { createClient } from '@supabase/supabase-js';
import { validateSettings } from '../../settingsSchema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function db() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function GET() {
  const { data, error } = await db()
    .from('doser_settings')
    .select('*')
    .eq('id', 1)
    .maybeSingle();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
  return Response.json(data ?? null);
}

export async function POST(req) {
  if (req.headers.get('x-ingest-token') !== process.env.INGEST_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // Valider som databasens constraints, så en klar besked returneres i stedet
  // for en rå database-fejl.
  const result = validateSettings(body);
  if (!result.ok) return new Response(result.error, { status: 400 });

  const { data, error } = await db()
    .from('doser_settings')
    .update({ ...result.values, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .select()
    .single();

  if (error) return new Response(error.message, { status: 500 });
  return Response.json(data);
}
