create table public.live_state (
  id smallint primary key default 1,
  ph double precision,
  ph_voltage double precision,
  water_temperature double precision,
  updated_at timestamptz not null default now(),
  constraint live_state_single_row check (id = 1)
);

insert into public.live_state (id) values (1);

alter table public.live_state enable row level security;

grant select, insert, update on table public.live_state to service_role;
