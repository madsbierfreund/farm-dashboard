alter table public.ph_readings
  add column if not exists ec double precision;

alter table public.live_state
  add column if not exists ec double precision;

drop function if exists public.readings_bucketed(timestamptz, timestamptz, integer);

create function public.readings_bucketed(
  from_ts timestamptz,
  to_ts timestamptz,
  buckets integer default 400
)
returns table (
  bucket_at timestamptz,
  ph double precision,
  water_temperature double precision,
  ec double precision,
  n integer
)
language sql
stable
as $$
  with p as (
    select greatest(
      1,
      extract(epoch from (to_ts - from_ts)) / greatest(1, buckets)
    ) as secs
  )
  select
    from_ts + (floor(extract(epoch from (r.recorded_at - from_ts)) / p.secs) * p.secs)
      * interval '1 second',
    percentile_cont(0.5) within group (order by r.ph)::double precision,
    percentile_cont(0.5) within group (order by r.water_temperature)::double precision,
    percentile_cont(0.5) within group (order by r.ec)::double precision,
    count(*)::integer
  from public.ph_readings r, p
  where r.recorded_at >= from_ts and r.recorded_at <= to_ts
  group by 1
  order by 1;
$$;

grant execute on function public.readings_bucketed(timestamptz, timestamptz, integer) to service_role;
