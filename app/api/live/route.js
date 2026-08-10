import { createClient } from '@supabase/supabase-js';

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
    .from('live_state')
    .select('ph, ph_voltage, water_temperature, updated_at')
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

  const ph = Number(body.ph);
  if (!Number.isFinite(ph) || ph < 0 || ph > 14) {
    return new Response('ph out of range', { status: 400 });
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const { error } = await db().from('live_state').upsert({
    id: 1,
    ph,
    ph_voltage: num(body.ph_voltage),
    water_temperature: num(body.water_temperature),
    updated_at: new Date().toISOString()
  });

  if (error) return new Response(error.message, { status: 500 });
  return new Response('ok');
}
