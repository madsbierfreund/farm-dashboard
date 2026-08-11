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
    return new Response('bad json', { status: 400 });
  }

  // En løbsk afsender må ikke kunne skrive vrøvl: ml skal være et endeligt
  // tal over 0 og højst 100.
  const ml = Number(body.ml);
  if (!Number.isFinite(ml) || ml <= 0 || ml > 100) {
    return new Response('ml out of range', { status: 400 });
  }

  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const { error } = await db().from('dose_events').insert({
    ml,
    seconds: num(body.seconds),
    kind: typeof body.kind === 'string' && body.kind ? body.kind : 'ph_down'
  });

  if (error) return new Response(error.message, { status: 500 });
  return new Response('ok');
}
