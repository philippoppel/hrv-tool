/**
 * Rolling-baseline trend detection for HRV metrics.
 *
 * Approach:
 * - Uses a rolling window (last 14 measurements before the recent streak)
 *   as personal baseline, not the all-time mean. This accounts for gradual
 *   fitness changes over months.
 * - Flags deviations only when they exceed normal day-to-day variability.
 *   The threshold is max(personal CV, published CV floor) × multiplier.
 *   Published CV floors: Plews et al. 2013, Nunan et al. 2010.
 * - Requires consecutive deviations in the same direction to filter noise.
 *
 * RMSSD is right-skewed; we compute stats on ln(value) for RMSSD/SDNN
 * (approximately normal after log-transform; Plews et al. 2013) and
 * back-transform for display.
 */

const METRICS = [
  { key: 'rmssd',       label: 'RMSSD',       unit: 'ms', higherBetter: true,  logTransform: true },
  { key: 'sdnn',        label: 'SDNN',         unit: 'ms', higherBetter: true,  logTransform: true },
  { key: 'stressIndex', label: 'Stress-Index', unit: '',   higherBetter: false, logTransform: false },
];

const MIN_BASELINE = 7;       // minimum measurements before activation
const ROLLING_WINDOW = 14;    // baseline window size
const CONSEC_NEEDED = 3;      // consecutive deviations to trigger
const CV_FLOOR = {            // published day-to-day CV floors
  rmssd: 0.20,               // ~15-25% (Plews et al. 2013)
  sdnn: 0.18,
  stressIndex: 0.25,         // inherently noisier
};
const DEVIATION_MULT = 1.5;  // flag at 1.5× effective CV
const STALE_GAP_DAYS = 7;    // break streak if gap > 7 days between measurements

// ── Helpers ──

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function std(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

// ── Core ──

function analyseMetric(sorted, currentIdx, metric) {
  const { key, higherBetter, logTransform } = metric;

  // We need at least MIN_BASELINE measurements before the recent window
  if (currentIdx < MIN_BASELINE + CONSEC_NEEDED - 1) {
    return { key, detected: false, reason: 'insufficient' };
  }

  // Build baseline: reserve a larger streak window so we can detect long streaks.
  // The baseline ends before the maximum possible streak area.
  const maxStreak = Math.min(10, currentIdx - MIN_BASELINE + 1);
  const baseEnd = currentIdx - maxStreak;               // last index included in baseline
  const baseStart = Math.max(0, baseEnd - ROLLING_WINDOW);
  const baseValues = [];
  for (let i = baseStart; i <= baseEnd; i++) {
    const v = sorted[i].metrics?.[key];
    if (v != null && v > 0) baseValues.push(v);
  }

  if (baseValues.length < MIN_BASELINE) {
    return { key, detected: false, reason: 'insufficient' };
  }

  // Compute baseline stats (optionally in log space)
  // For log-transformed data: std(ln(x)) ≈ CV(x), so no division by mean needed.
  const transform = logTransform ? Math.log : (x) => x;
  const untransform = logTransform ? Math.exp : (x) => x;

  const tValues = baseValues.map(transform);
  const baseMean = mean(tValues);
  const baseStd = std(tValues);
  const personalCV = logTransform
    ? baseStd                                       // std of ln(x) ≈ CV in original space
    : (baseMean !== 0 ? Math.abs(baseStd / baseMean) : 0);
  const effectiveCV = Math.max(personalCV, CV_FLOOR[key] || 0.20);
  const threshold = logTransform
    ? effectiveCV * DEVIATION_MULT                  // in log space, threshold is absolute
    : Math.abs(baseMean) * effectiveCV * DEVIATION_MULT;

  // Check consecutive recent measurements (from newest backwards)
  let consecCount = 0;
  let direction = null; // 'above' or 'below'
  const streakValues = [];

  for (let i = currentIdx; i > baseEnd && i >= 0; i--) {
    const v = sorted[i].metrics?.[key];
    if (v == null || v <= 0) break;

    // Check staleness: if gap to next measurement > STALE_GAP_DAYS, break
    if (i < currentIdx) {
      const gap = sorted[i + 1].timestamp - sorted[i].timestamp;
      if (gap > STALE_GAP_DAYS * 86400000) break;
    }

    const tv = transform(v);
    const diff = tv - baseMean;

    if (Math.abs(diff) <= threshold) break;

    const dir = diff > 0 ? 'above' : 'below';
    if (direction === null) {
      direction = dir;
    } else if (dir !== direction) {
      break;
    }

    consecCount++;
    streakValues.push(v);
  }

  if (consecCount < CONSEC_NEEDED) {
    return { key, detected: false, reason: 'no_streak' };
  }

  // Compute average deviation percentage (in original space)
  const baselineMeanOriginal = untransform(baseMean);
  const streakMean = mean(streakValues);
  const avgDeviationPct = +((streakMean - baselineMeanOriginal) / baselineMeanOriginal * 100).toFixed(1);

  // Classify direction
  const improving = (direction === 'above' && higherBetter) || (direction === 'below' && !higherBetter);

  return {
    key,
    label: metric.label,
    unit: metric.unit,
    detected: true,
    direction: improving ? 'improving' : 'declining',
    severity: consecCount >= 5 ? 'significant' : 'moderate',
    consecutiveCount: consecCount,
    avgDeviationPct,
    baselineMean: +baselineMeanOriginal.toFixed(1),
    effectiveCV: +(effectiveCV * 100).toFixed(1),
  };
}

// ── Public API ──

export function detectTrends(allMeasurements, currentId) {
  if (!allMeasurements || allMeasurements.length < MIN_BASELINE + CONSEC_NEEDED) {
    return { active: false, reason: 'insufficient_data', count: allMeasurements?.length || 0, trends: [] };
  }

  // Sort ascending by timestamp
  const sorted = [...allMeasurements].sort((a, b) => a.timestamp - b.timestamp);
  const currentIdx = sorted.findIndex(m => m.id === currentId);

  if (currentIdx < 0) {
    return { active: false, reason: 'not_found', count: sorted.length, trends: [] };
  }

  const trends = METRICS.map(metric => analyseMetric(sorted, currentIdx, metric));

  return {
    active: true,
    count: sorted.length,
    trends,
  };
}

export function buildTrendSection(trendResults) {
  if (!trendResults?.active) return null;

  const detected = trendResults.trends.filter(t => t.detected);
  if (detected.length === 0) return null;

  const declining = detected.filter(t => t.direction === 'declining');
  const improving = detected.filter(t => t.direction === 'improving');

  const parts = [];

  for (const t of declining) {
    const absD = Math.abs(t.avgDeviationPct);
    parts.push(
      `**${t.label}** liegt seit ${t.consecutiveCount} aufeinanderfolgenden Messungen im Mittel ` +
      `${absD}% ${t.avgDeviationPct < 0 ? 'unter' : 'über'} deiner persönlichen Baseline ` +
      `(⌀ ${t.baselineMean} ${t.unit} der letzten ${ROLLING_WINDOW} Messungen). ` +
      `Die normale Tagesschwankung liegt bei ~${t.effectiveCV}% — diese anhaltende Abweichung geht darüber hinaus. ` +
      (t.key === 'rmssd'
        ? 'Mögliche Ursachen: angesammelter Stress, unzureichende Erholung, Übertraining, beginnende Infektion.'
        : t.key === 'stressIndex'
          ? 'Ein anhaltend erhöhter Stress-Index deutet auf eine sympathische Dominanz hin.'
          : 'Anhaltend niedrige Gesamtvariabilität kann verschiedene Ursachen haben.')
    );
  }

  for (const t of improving) {
    const absD = Math.abs(t.avgDeviationPct);
    parts.push(
      `Positiver Trend: **${t.label}** liegt seit ${t.consecutiveCount} Messungen im Mittel ` +
      `${absD}% ${t.avgDeviationPct > 0 ? 'über' : 'unter'} deiner Baseline ` +
      `(⌀ ${t.baselineMean} ${t.unit}). Das deutet auf verbesserte Erholung oder Anpassung hin.`
    );
  }

  parts.push(
    '*Trend-Erkennung basiert auf statistischen Mustern deiner letzten Messungen, nicht auf medizinischer Diagnostik. ' +
    'Erst wenn ein Trend über 3+ Messungen anhält und die normale Tagesschwankung deutlich übersteigt, wird er hier angezeigt. ' +
    'Bei anhaltend negativen Trends und Symptomen: ärztlichen Rat einholen.*'
  );

  const icon = declining.length > 0 ? 'warn' : 'good';
  const title = declining.length > 0 ? 'Trend-Warnung' : 'Positiver Trend';

  return { title, icon, content: parts.join('\n\n') };
}
