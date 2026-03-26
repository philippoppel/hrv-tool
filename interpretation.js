/**
 * Evidence-based HRV interpretation module.
 *
 * Reference ranges for 5-minute recordings based on:
 * - Nunan et al. 2010 meta-analysis (21,438 healthy adults)
 * - Task Force of ESC/NASPE 1996 standards
 * - Shaffer & Ginsberg 2017 overview
 * - Baevsky stress index: Russian space medicine / Kubios validation
 *
 * This module intentionally avoids diagnostic language.
 * All outputs use hedging ("deutet auf ... hin", "könnte") and flag limitations.
 */

import { buildTrendSection } from './trends.js';

// ── Reference ranges (5-min short-term recordings, healthy adults) ──

const REF = {
  // Nunan et al. 2010 meta-analysis
  rmssd:  { low: 19, mean: 42, high: 75, unit: 'ms' },
  sdnn:   { low: 32, mean: 50, high: 93, unit: 'ms' },
  pnn50:  { low: 3, mean: 10, high: 40, unit: '%' },

  // Frequency domain - Nunan et al.
  lfPower:  { low: 193, mean: 519, high: 1009, unit: 'ms²' },
  hfPower:  { low: 83, mean: 657, high: 3630, unit: 'ms²' },
  lfHfRatio: { low: 1.1, mean: 2.8, high: 11.6 },
  lfNorm:   { low: 30, mean: 52, high: 65, unit: '%' },
  hfNorm:   { low: 16, mean: 40, high: 60, unit: '%' },

  // Baevsky Stress Index
  stressIndex: { low: 50, normal: 150, elevated: 500, high: 900 },

  // Heart rate
  meanHR: { bradyLow: 40, bradyHigh: 60, tachyThreshold: 100 },

  // SD1/SD2
  sd1sd2Ratio: { low: 0.2, high: 0.7 },
};

// ── Classification helpers ──

function classifyLevel(value, low, high) {
  if (value < low) return 'low';
  if (value > high) return 'high';
  return 'normal';
}

function classifyStress(si) {
  if (si < REF.stressIndex.low) return 'low';
  if (si < REF.stressIndex.normal) return 'normal';
  if (si < REF.stressIndex.elevated) return 'elevated';
  return 'high';
}

// ── Main interpretation function ──

export function generateInterpretation(metrics, averages, measurementCount, trendResults) {
  const sections = [];

  // ── 1. Data quality ──
  sections.push(buildQualitySection(metrics));

  // ── 2. Overall summary (the "headline") ──
  sections.push(buildSummarySection(metrics));

  // ── 3. Autonomic state (time domain) ──
  sections.push(buildTimeDomainSection(metrics));

  // ── 4. Frequency domain with caveats ──
  sections.push(buildFrequencySection(metrics));

  // ── 5. Stress & non-linear ──
  sections.push(buildNonLinearSection(metrics));

  // ── 6. Personal baseline comparison ──
  if (averages && measurementCount > 1) {
    sections.push(buildComparisonSection(metrics, averages, measurementCount));
  }

  // ── 7. Trend detection ──
  const trendSection = buildTrendSection(trendResults);
  if (trendSection) sections.push(trendSection);

  // ── 8. Disclaimer ──
  sections.push({
    title: 'Hinweis',
    icon: 'info',
    content: 'Dies ist keine medizinische Diagnose. Individuelle Trends sind aussagekräftiger als Einzelmessungen. ' +
      'Die Referenzwerte basieren auf 5-Minuten-Messungen gesunder Erwachsener (Nunan et al. 2010). ' +
      'Alter, Geschlecht, Fitness und Messbedingungen beeinflussen die Werte erheblich. ' +
      'Bei gesundheitlichen Bedenken einen Arzt konsultieren.'
  });

  return sections;
}

// ── Section builders ──

function buildQualitySection(m) {
  const parts = [];
  const pct = m.artifactPercent;

  if (pct <= 1) {
    parts.push('Signalqualität: sehr gut — weniger als 1 % Artefakte.');
  } else if (pct <= 5) {
    parts.push(`Signalqualität: akzeptabel (${m.artifactPercent} % Artefakte). Die Ergebnisse sind verwertbar, aber leichte Verzerrungen bei frequenzbasierten Metriken sind möglich.`);
  } else {
    parts.push(`Signalqualität: eingeschränkt (${m.artifactPercent} % Artefakte). Frequenzdomäne und Stress-Index können deutlich verzerrt sein. Ergebnisse mit Vorsicht interpretieren — beim nächsten Mal Brustgurt befeuchten und still sitzen.`);
  }

  if (m.totalBeats < 150) {
    parts.push(`Mit nur ${m.totalBeats} erkannten Schlägen in 5 Minuten ist die statistische Basis geringer als üblich. Das ist bei einem sehr niedrigen Ruhepuls normal, kann aber die Varianz der Metriken erhöhen.`);
  }

  return { title: 'Datenqualität', icon: pct > 5 ? 'warn' : 'ok', content: parts.join(' ') };
}

function buildSummarySection(m) {
  // Composite assessment based on key markers
  const rmssdLevel = classifyLevel(m.rmssd, REF.rmssd.low, REF.rmssd.high);
  const stressLevel = classifyStress(m.stressIndex);
  const hrCategory = m.meanHR < REF.meanHR.bradyHigh ? 'low' :
                     m.meanHR > REF.meanHR.tachyThreshold ? 'high' : 'normal';

  let summary;
  let icon;

  // Good: high RMSSD + low stress + low/normal HR
  if (rmssdLevel !== 'low' && stressLevel !== 'elevated' && stressLevel !== 'high' && hrCategory !== 'high') {
    icon = 'good';
    if (rmssdLevel === 'high' && stressLevel === 'low') {
      summary = 'Die Messung zeigt einen sehr guten Erholungszustand mit starkem Vagotonus. Die parasympathische Aktivität ist überdurchschnittlich — typisch für gut erholte oder trainierte Personen.';
    } else {
      summary = 'Die Messung zeigt einen normalen bis guten autonomen Zustand. Die Herzratenvariabilität liegt im erwartbaren Bereich.';
    }
  }
  // Bad: low RMSSD + high stress
  else if (rmssdLevel === 'low' && (stressLevel === 'elevated' || stressLevel === 'high')) {
    icon = 'warn';
    summary = 'Die Messung deutet auf eine erhöhte sympathische Aktivierung und reduzierte parasympathische Aktivität hin. Das kann Stress, Schlafmangel, Krankheit, intensive Belastung oder viele andere Ursachen haben — eine einzelne Messung ist nicht aussagekräftig.';
  }
  // Mixed
  else {
    icon = 'neutral';
    summary = 'Die Messung zeigt ein gemischtes Bild. Einzelne Werte liegen außerhalb des typischen Bereichs, was verschiedene Ursachen haben kann. Trends über mehrere Messungen sind aussagekräftiger.';
  }

  // Add HR context
  if (hrCategory === 'low') {
    summary += ` Der niedrige Ruhepuls von ${m.meanHR} bpm (Bradykardie) ist bei regelmäßigem Ausdauertraining normal und zeigt einen hohen Vagotonus.`;
    if (m.meanHR < REF.meanHR.bradyLow) {
      summary += ` Ein Wert unter ${REF.meanHR.bradyLow} bpm ist allerdings ungewöhnlich niedrig — falls Symptome wie Schwindel auftreten, ärztlich abklären lassen.`;
    }
  } else if (hrCategory === 'high') {
    summary += ` Der Ruhepuls von ${m.meanHR} bpm liegt über 100 bpm. Falls die Messbedingungen ruhig waren (Sitzen, kein Koffein), könnte das einen Blick wert sein.`;
  }

  return { title: 'Gesamteinschätzung', icon, content: summary };
}

function buildTimeDomainSection(m) {
  const parts = [];

  // RMSSD — the primary metric
  const rmssdLevel = classifyLevel(m.rmssd, REF.rmssd.low, REF.rmssd.high);
  if (rmssdLevel === 'high') {
    parts.push(`**RMSSD ${m.rmssd} ms** — überdurchschnittlich (Referenz: ${REF.rmssd.low}–${REF.rmssd.high} ms). Zeigt eine starke parasympathische (Vagus-)Aktivität. RMSSD ist der wissenschaftlich am besten validierte Marker für Kurzzeitmessungen.`);
  } else if (rmssdLevel === 'low') {
    parts.push(`**RMSSD ${m.rmssd} ms** — unterdurchschnittlich (Referenz: ${REF.rmssd.low}–${REF.rmssd.high} ms). Deutet auf eine reduzierte parasympathische Aktivität hin. Mögliche Ursachen: Stress, Schlafmangel, Übertraining, Erkältung, Koffein, Dehydrierung.`);
  } else {
    parts.push(`**RMSSD ${m.rmssd} ms** — im Normalbereich (Referenz: ${REF.rmssd.low}–${REF.rmssd.high} ms).`);
  }

  // SDNN
  const sdnnLevel = classifyLevel(m.sdnn, REF.sdnn.low, REF.sdnn.high);
  if (sdnnLevel === 'high') {
    parts.push(`**SDNN ${m.sdnn} ms** — hohe Gesamtvariabilität (Referenz: ${REF.sdnn.low}–${REF.sdnn.high} ms).`);
  } else if (sdnnLevel === 'low') {
    parts.push(`**SDNN ${m.sdnn} ms** — reduzierte Gesamtvariabilität (Referenz: ${REF.sdnn.low}–${REF.sdnn.high} ms). SDNN spiegelt die gesamte autonome Modulation wider, nicht nur den Parasympathikus.`);
  } else {
    parts.push(`**SDNN ${m.sdnn} ms** — im Normalbereich (Referenz: ${REF.sdnn.low}–${REF.sdnn.high} ms).`);
  }

  // pNN50
  if (m.pnn50 < REF.pnn50.low) {
    parts.push(`**pNN50 ${m.pnn50} %** liegt unter ${REF.pnn50.low} % — ein niedriger Wert, der die reduzierte parasympathische Aktivität bestätigt. pNN50 ist eng mit RMSSD korreliert.`);
  } else if (m.pnn50 > REF.pnn50.high) {
    parts.push(`**pNN50 ${m.pnn50} %** — sehr hoch (> ${REF.pnn50.high} %), was den starken Vagotonus bestätigt.`);
  }

  // HR range
  const hrRange = m.maxHR - m.minHR;
  if (hrRange > 40) {
    parts.push(`Die Herzfrequenz schwankte stark zwischen ${m.minHR} und ${m.maxHR} bpm (Spanne ${hrRange.toFixed(0)} bpm). Solche großen Schwankungen in einer Ruhemessung können auf Ektopie, Artefakte oder ausgeprägte respiratorische Sinusarrhythmie hindeuten.`);
  }

  return { title: 'Autonomer Zustand', icon: 'heart', content: parts.join('\n\n') };
}

function buildFrequencySection(m) {
  const parts = [];

  // General caveat
  parts.push('*Die Frequenzanalyse ist von der Atemfrequenz abhängig. Langsames Atmen (< 9 Atemzüge/min) verschiebt Energie vom HF- ins LF-Band — das ist kein Zeichen von Stress.*');

  // LF/HF ratio with strong caveat
  if (m.lfHfRatio != null) {
    const lfhfLevel = classifyLevel(m.lfHfRatio, REF.lfHfRatio.low, REF.lfHfRatio.high);
    let lfhfText = `**LF/HF-Verhältnis: ${m.lfHfRatio}** (Referenz: ${REF.lfHfRatio.low}–${REF.lfHfRatio.high}). `;

    lfhfText += 'Vorsicht bei der Interpretation: Entgegen verbreiteter Annahme bildet dieses Verhältnis die „sympathovagale Balance" nicht zuverlässig ab (Billman 2013). ' +
      'LF-Power enthält sowohl sympathische als auch parasympathische Anteile und wird stark vom Baroreflex beeinflusst.';

    if (lfhfLevel === 'high') {
      lfhfText += ' Der erhöhte Wert kann auf langsame Atmung, Baroreflexaktivität oder tatsächlich erhöhte sympathische Modulation zurückgehen.';
    }

    parts.push(lfhfText);
  }

  // HF Power
  if (m.hfPower != null) {
    const hfLevel = classifyLevel(m.hfPower, REF.hfPower.low, REF.hfPower.high);
    if (hfLevel === 'low') {
      parts.push(`**HF-Power: ${m.hfPower} ms²** — niedrig (Referenz: ${REF.hfPower.low}–${REF.hfPower.high} ms²). Bei langsamer Atmung kann die HF-Power künstlich niedrig erscheinen, weil die respiratorische Energie ins LF-Band wandert.`);
    } else if (hfLevel === 'high') {
      parts.push(`**HF-Power: ${m.hfPower} ms²** — hoch (Referenz: ${REF.hfPower.low}–${REF.hfPower.high} ms²). Deutet auf starke vagale Aktivität hin.`);
    }
  }

  // Normalized units context
  parts.push(`LF(norm) ${m.lfNorm} % / HF(norm) ${m.hfNorm} %: Normierte Werte zeigen die relative Verteilung, verlieren aber die Information über die absolute Höhe der autonomen Aktivität. Niedrige Total Power mit „normaler" Verteilung ist nicht dasselbe wie hohe Total Power mit gleicher Verteilung.`);

  return { title: 'Frequenzanalyse', icon: 'freq', content: parts.join('\n\n') };
}

function buildNonLinearSection(m) {
  const parts = [];

  // Stress Index
  const stressLevel = classifyStress(m.stressIndex);
  const siRef = `Referenz: < ${REF.stressIndex.low} niedrig, ${REF.stressIndex.low}–${REF.stressIndex.normal} normal, > ${REF.stressIndex.normal} erhöht`;

  if (stressLevel === 'low') {
    parts.push(`**Stress-Index: ${m.stressIndex}** — niedrig (${siRef}). Deutet auf einen entspannten Zustand mit dominanter parasympathischer Aktivität hin.`);
  } else if (stressLevel === 'normal') {
    parts.push(`**Stress-Index: ${m.stressIndex}** — im Normalbereich (${siRef}).`);
  } else if (stressLevel === 'elevated') {
    parts.push(`**Stress-Index: ${m.stressIndex}** — erhöht (${siRef}). Kann auf Stress, Belastung oder unzureichende Erholung hindeuten. Der Stress-Index ist allerdings empfindlich gegenüber Artefakten — einzelne Ausreißer können ihn stark beeinflussen.`);
  } else {
    parts.push(`**Stress-Index: ${m.stressIndex}** — deutlich erhöht (${siRef}). Falls die Signalqualität gut ist, deutet dies auf eine starke sympathische Aktivierung hin.`);
  }

  // Poincaré
  if (m.sd1 != null && m.sd2 != null) {
    parts.push(`**Poincaré-Analyse:** SD1 = ${m.sd1} ms (Kurzzeit, ≈ parasympathisch), SD2 = ${m.sd2} ms (Langzeit). ` +
      `SD1 ist mathematisch identisch mit RMSSD/√2 und liefert keine zusätzliche Information. ` +
      `Das SD1/SD2-Verhältnis von ${m.sd1sd2Ratio} ` +
      (m.sd1sd2Ratio < REF.sd1sd2Ratio.low
        ? 'ist niedrig — die Langzeitvariabilität dominiert deutlich.'
        : m.sd1sd2Ratio > REF.sd1sd2Ratio.high
          ? 'ist hoch — die Kurzzeit-(parasympathische) Variabilität ist relativ ausgeprägt.'
          : 'liegt im typischen Bereich (0,2–0,7).'));
  }

  return { title: 'Stress & Poincaré', icon: 'stress', content: parts.join('\n\n') };
}

function buildComparisonSection(metrics, averages, count) {
  const parts = [];

  parts.push(`Vergleich mit deinem persönlichen Durchschnitt über ${count} Messung${count > 1 ? 'en' : ''}:`);

  if (count < 7) {
    parts.push(`*Bei nur ${count} Messung${count > 1 ? 'en' : ''} ist der Durchschnitt noch wenig aussagekräftig. Mindestens 7–14 Messungen ergeben ein zuverlässiges Baseline.*`);
  }

  // Key metrics comparison
  const comparisons = [
    { key: 'rmssd', label: 'RMSSD', unit: 'ms', higherBetter: true },
    { key: 'sdnn', label: 'SDNN', unit: 'ms', higherBetter: true },
    { key: 'stressIndex', label: 'Stress-Index', unit: '', higherBetter: false },
  ];

  for (const { key, label, unit, higherBetter } of comparisons) {
    const val = metrics[key];
    const avg = averages[key];
    if (val == null || avg == null || avg === 0) continue;

    const pct = ((val - avg) / avg * 100).toFixed(1);
    const absVal = Math.abs(pct);
    const sign = pct > 0 ? '+' : '';

    if (absVal < 10) {
      parts.push(`**${label}**: ${val} ${unit} — nahe am Durchschnitt (⌀ ${avg} ${unit}, ${sign}${pct} %).`);
    } else {
      const direction = pct > 0 ? 'über' : 'unter';
      const assessment = (pct > 0) === higherBetter ? 'positiv' : 'auffällig';
      parts.push(`**${label}**: ${val} ${unit} — ${absVal > 50 ? 'deutlich ' : ''}${direction} dem Durchschnitt (⌀ ${avg} ${unit}, ${sign}${pct} %). Tendenz: ${assessment}.`);
    }
  }

  parts.push('*Einzelne Abweichungen sind normal. Erst anhaltende Trends über 3+ Messungen sind aussagekräftig.*');

  return { title: 'Persönlicher Vergleich', icon: 'trend', content: parts.join('\n\n') };
}
