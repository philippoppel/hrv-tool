const HIGHER_IS_BETTER = ['rmssd', 'sdnn', 'pnn50', 'hfPower', 'sd1', 'sd2', 'totalPower'];
const LOWER_IS_BETTER = ['stressIndex', 'lfHfRatio', 'meanHR'];

export function compare(currentMetrics, averages) {
  if (!averages) return {};

  const result = {};
  const allKeys = [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER];

  for (const key of allKeys) {
    const value = currentMetrics[key];
    const avg = averages[key];
    if (value == null || avg == null || avg === 0) continue;

    const deviation = (value - avg) / avg;
    const deviationPct = +(deviation * 100).toFixed(1);

    // Flag extreme deviations (>90%) as questionable — likely insufficient baseline data
    const questionable = Math.abs(deviationPct) > 90;

    let rating;
    if (HIGHER_IS_BETTER.includes(key)) {
      rating = deviation > 0.1 ? 'good' : deviation < -0.1 ? 'bad' : 'neutral';
    } else {
      rating = deviation < -0.1 ? 'good' : deviation > 0.1 ? 'bad' : 'neutral';
    }

    // Don't color-code questionable deviations — they mislead more than they help
    if (questionable) rating = 'neutral';

    result[key] = {
      value,
      average: avg,
      deviation: deviationPct,
      rating,
      questionable
    };
  }

  return result;
}

export function getTrendData(history, metricKey, lastN = 30) {
  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp).slice(-lastN);
  return {
    labels: sorted.map(m => new Date(m.timestamp).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })),
    values: sorted.map(m => m.metrics?.[metricKey] ?? null),
    timestamps: sorted.map(m => m.timestamp)
  };
}

export function getRatingColor(rating) {
  switch (rating) {
    case 'good': return '#4ade80';
    case 'bad': return '#f87171';
    default: return '#fbbf24';
  }
}
