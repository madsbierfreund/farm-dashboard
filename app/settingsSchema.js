// Delt validering af doseringsindstillinger. Bruges baade i browseren (før
// gem) og på serveren (API-route + server-action), så reglerne kun findes ét
// sted og matcher databasens constraints i 004_doser_settings.sql.

// Talfelter der vises i panelet, med grænser til input-hints.
export const NUMBER_FIELDS = [
  { key: 'dose_above', label: 'Doser over (pH)', step: 0.1, min: 4.0, max: 9.0 },
  { key: 'target_ph', label: 'Mål (pH)', step: 0.1, min: 4.0, max: 9.0 },
  { key: 'cooldown_minutes', label: 'Nedkøling (minutter)', step: 1, min: 5, max: 1440 },
  { key: 'max_doses_per_day', label: 'Maks doser pr. dag', step: 1, min: 1, max: 100 },
  { key: 'consecutive_readings', label: 'Målinger i træk', step: 1, min: 1, max: 20 }
];

export const DEFAULTS = {
  enabled: true,
  dose_above: 6.3,
  target_ph: 6.0,
  cooldown_minutes: 30,
  max_doses_per_day: 20,
  consecutive_readings: 3
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

  const enabled = asBool(input.enabled);
  if (enabled === null) return err('Til/fra skal være enten til eller fra.');

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

  return {
    ok: true,
    values: {
      enabled,
      dose_above: doseAbove,
      target_ph: targetPh,
      cooldown_minutes: cooldown,
      max_doses_per_day: maxDoses,
      consecutive_readings: consecutive
    }
  };
}
