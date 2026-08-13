create or replace function public.readings_bucketed(
  from_ts timestamptz,
  to_ts timestamptz,
  buckets integer default 400
)
returns table (
  bucket_at timestamptz,
  ph double precision,
  water_temperature double precision,
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
    count(*)::integer
  from public.ph_readings r, p
  where r.recorded_at >= from_ts and r.recorded_at <= to_ts
  group by 1
  order by 1;
$$;

create or replace function public.readings_stats(
  from_ts timestamptz,
  to_ts timestamptz
)
returns table (
  min_ph double precision,
  avg_ph double precision,
  max_ph double precision,
  n bigint
)
language sql
stable
as $$
  select min(ph), avg(ph), max(ph), count(*)
  from public.ph_readings
  where recorded_at >= from_ts and recorded_at <= to_ts;
$$;

grant execute on function public.readings_bucketed(timestamptz, timestamptz, integer) to service_role;
grant execute on function public.readings_stats(timestamptz, timestamptz) to service_role;
