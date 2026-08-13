import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function db() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

export async function POST(req) {
  if (req.headers.get('x-ingest-token') !== process.env.INGEST_TOKEN) {
    return new Response('unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const volume = body.volume_ml == null ? 500 : Number(body.volume_ml);
  if (!Number.isFinite(volume) || volume <= 0 || volume > 20000) {
    return new Response('volume_ml out of range', { status: 400 });
  }

  const kind =
    typeof body.kind === 'string' && body.kind ? body.kind : 'ph_down';

  const { data, error } = await db()
    .from('dose_refills')
    .insert({ volume_ml: volume, kind })
    .select()
    .single();

  if (error) return new Response(error.message, { status: 500 });
  return Response.json(data);
}
