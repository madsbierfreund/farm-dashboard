create table public.dose_refills (
  id bigint generated always as identity primary key,
  refilled_at timestamptz not null default now(),
  volume_ml double precision not null,
  kind text not null default 'ph_down',
  constraint dose_refills_volume_sane check (volume_ml > 0 and volume_ml <= 20000)
);

create index dose_refills_refilled_at_idx
  on public.dose_refills (kind, refilled_at desc);

insert into public.dose_refills (volume_ml, kind) values (500, 'ph_down');

alter table public.dose_refills enable row level security;

grant select, insert on table public.dose_refills to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.dose_remaining(p_kind text default 'ph_down')
returns table (
  refilled_at timestamptz,
  volume_ml double precision,
  used_ml double precision,
  remaining_ml double precision,
  ml_per_day double precision,
  days_left double precision
)
language sql
stable
as $$
  with last_fill as (
    select r.refilled_at, r.volume_ml
    from public.dose_refills r
    where r.kind = p_kind
    order by r.refilled_at desc
    limit 1
  ),
  win as (
    select
      f.refilled_at,
      f.volume_ml,
      greatest(f.refilled_at, now() - interval '7 days') as since
    from last_fill f
  ),
  agg as (
    select
      w.refilled_at,
      w.volume_ml,
      w.since,
      coalesce(sum(d.ml), 0)::double precision as used_ml,
      coalesce(sum(d.ml) filter (where d.dosed_at >= w.since), 0)::double precision as ml_recent
    from win w
    left join public.dose_events d
      on d.kind = p_kind
     and d.dosed_at >= w.refilled_at
    group by w.refilled_at, w.volume_ml, w.since
  )
  select
    a.refilled_at,
    a.volume_ml,
    a.used_ml,
    greatest(a.volume_ml - a.used_ml, 0)::double precision,
    (a.ml_recent / greatest(extract(epoch from (now() - a.since)) / 86400, 0.05))::double precision,
    case
      when a.ml_recent > 0
       and extract(epoch from (now() - a.since)) / 86400 >= 0.5
      then (greatest(a.volume_ml - a.used_ml, 0)
            / (a.ml_recent / (extract(epoch from (now() - a.since)) / 86400)))::double precision
      else null
    end
  from agg a;
$$;

grant execute on function public.dose_remaining(text) to service_role;
