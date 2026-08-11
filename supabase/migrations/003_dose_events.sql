create table public.dose_events (
  id bigint generated always as identity primary key,
  dosed_at timestamptz not null default now(),
  ml double precision not null,
  seconds double precision,
  kind text not null default 'ph_down'
);

create index dose_events_dosed_at_idx
  on public.dose_events (dosed_at desc);

alter table public.dose_events enable row level security;

grant select, insert on table public.dose_events to service_role;
grant usage, select on all sequences in schema public to service_role;
