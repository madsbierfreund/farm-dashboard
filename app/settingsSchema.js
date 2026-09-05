// Delt validering af doserings- og EC-indstillinger. Bruges baade i browseren
// (før gem) og på serveren (API-route + server-action), så reglerne kun findes
// ét sted og matcher databasens constraints i 004_/008_ migrationerne.

// Talfelter der vises i pH-panelet, med grænser til input-hints.
export const NUMBER_FIELDS = [
  { key: 'dose_above', label: 'Doser over (pH)', step: 0.1, min: 4.0, max: 9.0 },
  { key: 'target_ph', label: 'Mål (pH)', step: 0.1, min: 4.0, max: 9.0 },
  { key: 'cooldown_minutes', label: 'Nedkøling (minutter)', step: 1, min: 5, max: 1440 },
  { key: 'max_doses_per_day', label: 'Maks doser pr. dag', step: 1, min: 1, max: 100 },
  { key: 'consecutive_readings', label: 'Målinger i træk', step: 1, min: 1, max: 20 }
];

// Talfelter i EC-gødningspanelet.
export const EC_NUMBER_FIELDS = [
  { key: 'ec_target', label: 'EC-mål (mS/cm)', step: 0.05, min: 0.1, max: 5.0 },
  { key: 'ec_deadband', label: 'Dødbånd (mS/cm)', step: 0.05, min: 0, max: 1.0 },
  { key: 'ec_cooldown_minutes', label: 'Nedkøling (minutter)', step: 1, min: 5, max: 1440 },
  { key: 'ec_max_doses_per_day', label: 'Maks doser pr. dag', step: 1, min: 1, max: 100 },
  { key: 'ec_consecutive_readings', label: 'Målinger i træk', step: 1, min: 1, max: 20 },
  { key: 'dose_ml_grow', label: 'Grow pr. dosis (ml)', step: 0.1, min: 0.1, max: 100 }
];

// Vækststadier og forholdet Grow : Micro : Bloom for hvert. Micro og Bloom
// skaleres fra Grow-mængden. Skal matche STAGE_RATIOS i bridge/ec_doser.py.
export const STAGE_RATIOS = {
  growing: { grow: 1.8, micro: 1.2, bloom: 0.6 },
  preflowering: { grow: 2.0, micro: 2.0, bloom: 1.5 },
  flowering: { grow: 0.8, micro: 1.6, bloom: 2.4 }
};
export const STAGES = Object.keys(STAGE_RATIOS);
export const STAGE_LABELS = {
  growing: 'Vækst',
  preflowering: 'Førblomstring',
  flowering: 'Blomstring'
};

// De tre volumener (ml) for en given stage og Grow-mængde.
export function doseVolumes(stage, doseMlGrow) {
  const r = STAGE_RATIOS[stage] || STAGE_RATIOS.growing;
  const grow = Number(doseMlGrow);
  return {
    grow,
    micro: grow * (r.micro / r.grow),
    bloom: grow * (r.bloom / r.grow)
  };
}

export const DEFAULTS = {
  enabled: true,
  dose_above: 6.3,
  target_ph: 6.0,
  cooldown_minutes: 30,
  max_doses_per_day: 20,
  consecutive_readings: 3,
  ec_enabled: false,
  ec_target: 1.8,
  ec_deadband: 0.15,
  ec_cooldown_minutes: 60,
  ec_max_doses_per_day: 6,
  ec_consecutive_readings: 3,
  growth_stage: 'growing',
  dose_ml_grow: 2.0
};

function asBool(v) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// Returnerer { ok: true, values } eller { ok: false, error } med en klar,
// dansk besked — så vi aldrig lader en rå database-fejl slippe igennem.
export function validateSettings(input) {
  const err = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object') return err('Ugyldige data.');

  // --- pH ---
  const enabled = asBool(input.enabled);
  if (enabled === null) return err('pH til/fra skal være enten til eller fra.');

  const doseAbove = Number(input.dose_above);
  const targetPh = Number(input.target_ph);
  const cooldown = Number(input.cooldown_minutes);
  const maxDoses = Number(input.max_doses_per_day);
  const consecutive = Number(input.consecutive_readings);

  if (!Number.isFinite(doseAbove) || doseAbove > 9.0) {
    return err('Doser over skal være et tal på højst 9,0.');
  }
  if (!Number.isFinite(targetPh) || targetPh < 4.0) {
    return err('Mål skal være et tal på mindst 4,0.');
  }
  if (!(doseAbove > targetPh)) {
    return err('Doser over skal være højere end mål.');
  }
  if (!Number.isInteger(cooldown) || cooldown < 5) {
    return err('Nedkøling skal være et helt tal på mindst 5 minutter.');
  }
  if (!Number.isInteger(maxDoses) || maxDoses < 1 || maxDoses > 100) {
    return err('Maks doser pr. dag skal være et helt tal mellem 1 og 100.');
  }
  if (!Number.isInteger(consecutive) || consecutive < 1 || consecutive > 20) {
    return err('Målinger i træk skal være et helt tal mellem 1 og 20.');
  }

  // --- EC ---
  const ecEnabled = asBool(input.ec_enabled);
  if (ecEnabled === null) return err('EC til/fra skal være enten til eller fra.');

  const ecTarget = Number(input.ec_target);
  const ecDeadband = Number(input.ec_deadband);
  const ecCooldown = Number(input.ec_cooldown_minutes);
  const ecMaxDoses = Number(input.ec_max_doses_per_day);
  const ecConsecutive = Number(input.ec_consecutive_readings);
  const doseMlGrow = Number(input.dose_ml_grow);
  const stage = input.growth_stage;

  if (!Number.isFinite(ecTarget) || ecTarget <= 0 || ecTarget > 5.0) {
    return err('EC-mål skal være et tal mellem 0 og 5,0.');
  }
  if (!Number.isFinite(ecDeadband) || ecDeadband < 0 || ecDeadband > 1.0) {
    return err('Dødbånd skal være et tal mellem 0 og 1,0.');
  }
  if (!Number.isInteger(ecCooldown) || ecCooldown < 5) {
    return err('EC-nedkøling skal være et helt tal på mindst 5 minutter.');
  }
  if (!Number.isInteger(ecMaxDoses) || ecMaxDoses < 1 || ecMaxDoses > 100) {
    return err('EC maks doser pr. dag skal være et helt tal mellem 1 og 100.');
  }
  if (!Number.isInteger(ecConsecutive) || ecConsecutive < 1 || ecConsecutive > 20) {
    return err('EC målinger i træk skal være et helt tal mellem 1 og 20.');
  }
  if (!STAGES.includes(stage)) {
    return err('Vækststadie skal være vækst, førblomstring eller blomstring.');
  }
  if (!Number.isFinite(doseMlGrow) || doseMlGrow <= 0 || doseMlGrow > 100) {
    return err('Grow pr. dosis skal være et tal mellem 0 og 100 ml.');
  }

  return {
    ok: true,
    values: {
      enabled,
      dose_above: doseAbove,
      target_ph: targetPh,
      cooldown_minutes: cooldown,
      max_doses_per_day: maxDoses,
      consecutive_readings: consecutive,
      ec_enabled: ecEnabled,
      ec_target: ecTarget,
      ec_deadband: ecDeadband,
      ec_cooldown_minutes: ecCooldown,
      ec_max_doses_per_day: ecMaxDoses,
      ec_consecutive_readings: ecConsecutive,
      growth_stage: stage,
      dose_ml_grow: doseMlGrow
    }
  };
}
