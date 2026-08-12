create table public.doser_settings (
  id smallint primary key default 1,
  enabled boolean not null default true,
  dose_above double precision not null default 6.3,
  target_ph double precision not null default 6.0,
  cooldown_minutes integer not null default 30,
  max_doses_per_day integer not null default 20,
  consecutive_readings integer not null default 3,
  updated_at timestamptz not null default now(),
  constraint doser_settings_single_row check (id = 1),
  constraint doser_settings_sane check (
    dose_above > target_ph
    and target_ph >= 4.0
    and dose_above <= 9.0
    and cooldown_minutes >= 5
    and max_doses_per_day between 1 and 100
    and consecutive_readings between 1 and 20
  )
);

insert into public.doser_settings (id) values (1);

alter table public.doser_settings enable row level security;

grant select, insert, update on table public.doser_settings to service_role;
