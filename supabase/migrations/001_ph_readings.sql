create table public.ph_readings (
  id bigint generated always as identity primary key,
  recorded_at timestamptz not null default now(),
  ph double precision not null,
  ph_voltage double precision,
  water_temperature double precision,
  source text not null default 'farm-ph-node'
);

create index ph_readings_recorded_at_idx
  on public.ph_readings (recorded_at desc);

alter table public.ph_readings enable row level security;

grant usage on schema public to service_role;
grant select, insert on table public.ph_readings to service_role;
grant usage, select on all sequences in schema public to service_role;
