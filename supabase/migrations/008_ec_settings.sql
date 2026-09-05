-- EC-gødningsdosering: udvid den enkelte indstillingsraekke med EC-felterne.
-- (Denne migration er IKKE koert paa produktion endnu — koer den i SQL Editor.)

alter table public.doser_settings
  add column if not exists ec_enabled boolean not null default false,
  add column if not exists ec_target double precision not null default 1.8,
  add column if not exists ec_deadband double precision not null default 0.15,
  add column if not exists ec_cooldown_minutes integer not null default 60,
  add column if not exists ec_max_doses_per_day integer not null default 6,
  add column if not exists ec_consecutive_readings integer not null default 3,
  add column if not exists growth_stage text not null default 'growing',
  add column if not exists dose_ml_grow double precision not null default 2.0;

alter table public.doser_settings
  add constraint doser_settings_ec_sane check (
    ec_target > 0 and ec_target <= 5.0
    and ec_deadband >= 0 and ec_deadband <= 1.0
    and ec_cooldown_minutes >= 5
    and ec_max_doses_per_day between 1 and 100
    and ec_consecutive_readings between 1 and 20
    and growth_stage in ('growing', 'preflowering', 'flowering')
    and dose_ml_grow > 0 and dose_ml_grow <= 100
  );
