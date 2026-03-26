import { HRMonitor } from './bluetooth.js';
import { calculateHRV } from './hrv.js';
import { Storage } from './storage.js';
import { compare, getTrendData, getRatingColor } from './comparison.js';
import { generateInterpretation } from './interpretation.js';
import { detectTrends } from './trends.js';

const MEASUREMENT_DURATION = 300; // seconds
const STABILITY_WINDOW = 10; // last N HR values to check
const STABILITY_THRESHOLD = 15; // max HR spread for "stable"

const App = {
  state: null,
  monitor: new HRMonitor(),
  rrBuffer: [],
  hrBuffer: [],
  liveRRBuffer: [], // RR intervals during live phase for stability check
  measurementStart: null,
  timerInterval: null,
  charts: {},
  currentResults: null,

  init() {
    // Check Web Bluetooth support
    if (!navigator.bluetooth) {
      document.getElementById('browser-warning').style.display = 'block';
      document.getElementById('btn-start').disabled = true;
      document.getElementById('btn-start').style.opacity = '0.4';
    }

    // Show history link if data exists
    if (Storage.getAll().length > 0) {
      document.getElementById('btn-history-landing').style.display = '';
    }

    // Bind events
    document.getElementById('btn-start').addEventListener('click', () => this.startConnection());
    document.getElementById('btn-go').addEventListener('click', () => this.startMeasurement());
    document.getElementById('btn-cancel').addEventListener('click', () => this.cancelMeasurement());
    document.getElementById('btn-new-measurement').addEventListener('click', () => this.reset());
    document.getElementById('btn-to-history').addEventListener('click', () => this.showHistory());
    document.getElementById('btn-history-landing').addEventListener('click', () => this.showHistory());
    document.getElementById('btn-back-landing').addEventListener('click', () => this.reset());
    document.getElementById('btn-export').addEventListener('click', () => this.exportData());

    // Monitor callbacks
    this.monitor.onHeartRate = (hr) => this.onHeartRate(hr);
    this.monitor.onRRInterval = (rr) => this.onRRInterval(rr);
    this.monitor.onDisconnect = () => this.onDisconnect();

    this.setState('LANDING');
  },

  setState(newState) {
    this.state = newState;
    const views = ['landing', 'connecting', 'livehr', 'measuring', 'results', 'history'];
    for (const v of views) {
      const el = document.getElementById(`view-${v}`);
      el.classList.toggle('active', v === newState.toLowerCase().replace('live_hr', 'livehr'));
    }
  },

  // ── Connection ──

  async startConnection() {
    this.setState('CONNECTING');
    const errorEl = document.getElementById('connect-error');
    errorEl.classList.remove('visible');

    try {
      document.querySelector('.connecting-text').textContent = 'Suche bekannte Geräte...';
      await this.monitor.connect();
      this.hrBuffer = [];
      this.liveRRBuffer = [];
      this.initLiveHRChart();
      document.getElementById('btn-go').disabled = true;
      document.getElementById('btn-go').style.opacity = '0.4';
      document.getElementById('stability-status').textContent = 'Warte auf stabile Daten...';
      this.setState('LIVE_HR');
    } catch (err) {
      errorEl.textContent = err.message || 'Verbindung fehlgeschlagen. Bitte erneut versuchen.';
      errorEl.classList.add('visible');
      setTimeout(() => this.setState('LANDING'), 2000);
    }
  },

  async onDisconnect() {
    console.log(`[APP] Disconnect in state ${this.state}`);

    if (this.state === 'MEASURING') {
      // Try to reconnect instead of cancelling
      document.querySelector('.measuring-status').textContent = 'Verbindung verloren — versuche Reconnect...';
      document.querySelector('.measuring-status').style.color = '#fbbf24';

      const reconnected = await this._tryReconnect();
      if (reconnected) {
        document.querySelector('.measuring-status').textContent = 'Wieder verbunden. Messung läuft weiter...';
        document.querySelector('.measuring-status').style.color = '#4ade80';
        setTimeout(() => {
          document.querySelector('.measuring-status').textContent = 'Atme ruhig weiter. Die Messung läuft...';
          document.querySelector('.measuring-status').style.color = '';
        }, 3000);
        return;
      }

      // Only cancel if we have too few beats to salvage
      if (this.rrBuffer.length >= 30) {
        // Enough data — finish early
        document.querySelector('.measuring-status').textContent = 'Reconnect fehlgeschlagen — werte vorhandene Daten aus...';
        setTimeout(() => this.finishMeasurement(), 1500);
      } else {
        this.cancelMeasurement();
      }
      return;
    }

    if (this.state === 'LIVE_HR') {
      this.setState('LANDING');
    }
  },

  async _tryReconnect() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`[APP] Reconnect attempt ${attempt}/3`);
      try {
        await this.monitor.reconnect();
        console.log('[APP] Reconnect succeeded');
        return true;
      } catch (e) {
        console.log(`[APP] Reconnect attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
      }
    }
    return false;
  },

  // ── Live HR ──

  onHeartRate(hr) {
    if (this.state === 'LIVE_HR' || this.state === 'MEASURING') {
      document.getElementById('hr-value').textContent = hr;
    }

    if (this.state === 'LIVE_HR') {
      const now = Date.now();
      this.hrBuffer.push({ time: now, hr });
      // Keep last 30 seconds
      const cutoff = now - 30000;
      this.hrBuffer = this.hrBuffer.filter(p => p.time >= cutoff);
      this.updateLiveHRChart();
    }
  },

  onRRInterval(rr) {
    if (this.state === 'LIVE_HR') {
      this.liveRRBuffer.push(rr);
      // Keep last 20 RR intervals for stability check
      if (this.liveRRBuffer.length > 20) this.liveRRBuffer.shift();
      this.checkStability();
    }
    if (this.state === 'MEASURING') {
      this.rrBuffer.push(rr);
      document.getElementById('beat-count').textContent = this.rrBuffer.length;
      this.updatePoincareLive();
    }
  },

  checkStability() {
    const rrs = this.liveRRBuffer;
    if (rrs.length < STABILITY_WINDOW) {
      document.getElementById('stability-status').textContent =
        `Warte auf stabile Daten... (${rrs.length}/${STABILITY_WINDOW})`;
      return;
    }

    const recent = rrs.slice(-STABILITY_WINDOW);
    const minRR = Math.min(...recent);
    const maxRR = Math.max(...recent);
    const spread = maxRR - minRR;
    const median = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    // Check: no extreme outliers (>30% from median) and spread reasonable
    const hasOutlier = recent.some(rr => Math.abs(rr - median) / median > 0.30);
    const spreadOk = spread < median * 0.5;

    const stable = spreadOk && !hasOutlier;
    const btn = document.getElementById('btn-go');
    const status = document.getElementById('stability-status');

    if (stable) {
      btn.disabled = false;
      btn.style.opacity = '1';
      status.textContent = 'Signal stabil — bereit zur Messung';
      status.style.color = '#4ade80';
    } else {
      btn.disabled = true;
      btn.style.opacity = '0.4';
      status.textContent = 'Signal noch instabil — Gurt prüfen / anfeuchten';
      status.style.color = '#fbbf24';
    }
  },

  // ── Measurement ──

  startMeasurement() {
    this.rrBuffer = [];
    this.measurementStart = Date.now();
    this.setState('MEASURING');
    this.initPoincareLiveChart();

    document.getElementById('beat-count').textContent = '0';
    this.updateTimer();
    this.timerInterval = setInterval(() => this.updateTimer(), 200);
  },

  updateTimer() {
    const elapsed = (Date.now() - this.measurementStart) / 1000;
    const remaining = Math.max(0, MEASUREMENT_DURATION - elapsed);
    const min = Math.floor(remaining / 60);
    const sec = Math.floor(remaining % 60);
    document.getElementById('timer').textContent = `${min}:${sec.toString().padStart(2, '0')}`;

    if (remaining <= 0) {
      this.finishMeasurement();
    }
  },

  cancelMeasurement() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;
    this.rrBuffer = [];
    this.destroyChart('poincareLive');
    if (this.monitor.isConnected) {
      this.hrBuffer = [];
      this.initLiveHRChart();
      this.setState('LIVE_HR');
    } else {
      this.setState('LANDING');
    }
  },

  playCompletionSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Two-tone chime: C5 then E5
      const notes = [523.25, 659.25];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.2);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.2 + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.2);
        osc.stop(ctx.currentTime + i * 0.2 + 0.5);
      });
    } catch (e) {
      // Audio not supported — silent fallback
    }
  },

  finishMeasurement() {
    clearInterval(this.timerInterval);
    this.timerInterval = null;

    this.playCompletionSound();

    if (this.rrBuffer.length < 30) {
      alert('Zu wenige Herzschläge aufgezeichnet. Bitte erneut versuchen.');
      this.cancelMeasurement();
      return;
    }

    const metrics = calculateHRV(this.rrBuffer);
    const measurement = {
      id: 'm_' + Date.now(),
      timestamp: Date.now(),
      date: new Date().toISOString(),
      rawRR: [...this.rrBuffer],
      metrics
    };

    Storage.save(measurement);
    this.currentResults = measurement;
    this.showResults(measurement);
  },

  // ── Results ──

  showResults(measurement) {
    this.setState('RESULTS');
    const m = measurement.metrics;
    const averages = Storage.getAverages(measurement.id);
    const comp = compare(m, averages);

    document.getElementById('results-date').textContent =
      new Date(measurement.timestamp).toLocaleString('de-DE', {
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

    // Snapshot — at-a-glance summary
    this.renderSnapshot(m);

    // Time domain
    this.renderMetrics('metrics-time', [
      { key: 'meanHR', label: 'Mittlere HF', value: m.meanHR, unit: 'bpm' },
      { key: 'meanRR', label: 'Mittleres RR', value: m.meanRR, unit: 'ms' },
      { key: 'sdnn', label: 'SDNN', value: m.sdnn, unit: 'ms' },
      { key: 'rmssd', label: 'RMSSD', value: m.rmssd, unit: 'ms' },
      { key: 'pnn50', label: 'pNN50', value: m.pnn50, unit: '%' },
      { key: 'nn50', label: 'NN50', value: m.nn50, unit: '' },
      { key: 'minHR', label: 'Min HF', value: m.minHR, unit: 'bpm' },
      { key: 'maxHR', label: 'Max HF', value: m.maxHR, unit: 'bpm' },
    ], comp);

    // Frequency domain
    this.renderMetrics('metrics-freq', [
      { key: 'lfPower', label: 'LF Power', value: m.lfPower, unit: 'ms²' },
      { key: 'hfPower', label: 'HF Power', value: m.hfPower, unit: 'ms²' },
      { key: 'totalPower', label: 'Total Power', value: m.totalPower, unit: 'ms²' },
      { key: 'lfHfRatio', label: 'LF/HF', value: m.lfHfRatio, unit: '' },
      { key: 'lfNorm', label: 'LF (norm)', value: m.lfNorm, unit: '%' },
      { key: 'hfNorm', label: 'HF (norm)', value: m.hfNorm, unit: '%' },
    ], comp);

    // Non-linear
    this.renderMetrics('metrics-nonlinear', [
      { key: 'sd1', label: 'SD1', value: m.sd1, unit: 'ms' },
      { key: 'sd2', label: 'SD2', value: m.sd2, unit: 'ms' },
      { key: 'sd1sd2Ratio', label: 'SD1/SD2', value: m.sd1sd2Ratio, unit: '' },
      { key: 'stressIndex', label: 'Stress Index', value: m.stressIndex, unit: '' },
      { key: 'artifactPercent', label: 'Artefakte', value: m.artifactPercent, unit: '%' },
      { key: 'totalBeats', label: 'Schläge', value: m.totalBeats, unit: '' },
    ], comp);

    // Poincaré plot
    this.renderPoincareChart(m.poincareX, m.poincareY);

    // PSD chart
    this.renderPSDChart(m.psdFreqs, m.psdValues);

    // Textual interpretation with trend detection
    const allMeasurements = Storage.getAll();
    const otherCount = allMeasurements.filter(x => x.id !== measurement.id).length;
    const trendResults = detectTrends(allMeasurements, measurement.id);
    const sections = generateInterpretation(m, averages, otherCount, trendResults);
    this.renderInterpretation(sections);
  },

  renderSnapshot(m) {
    // Classify overall state
    const rmssdLow = 19, rmssdHigh = 75;
    const siLow = 50, siNormal = 150, siElevated = 500;
    const rmssdOk = m.rmssd >= rmssdLow;
    const stressOk = m.stressIndex < siElevated;

    let badge, badgeIcon, headline, subline;
    if (rmssdOk && stressOk && m.stressIndex < siNormal) {
      badge = 'good'; badgeIcon = '\u2713';
      headline = 'Guter Erholungszustand';
      subline = 'Parasympathische Aktivität und Stresslevel im grünen Bereich';
    } else if (!rmssdOk && !stressOk) {
      badge = 'warn'; badgeIcon = '!';
      headline = 'Erhöhte Belastung erkennbar';
      subline = 'Niedrige Variabilität bei erhöhtem Stresslevel';
    } else {
      badge = 'mixed'; badgeIcon = '~';
      headline = 'Gemischtes Bild';
      subline = 'Einzelne Werte außerhalb des Normalbereichs';
    }

    // Bar items: { name, value, unit, min, max, zones: [{start,end,color}], color }
    const items = [
      {
        name: 'RMSSD', value: m.rmssd, unit: 'ms',
        min: 0, max: 120,
        zones: [
          { start: 0, end: rmssdLow, color: 'var(--red)' },
          { start: rmssdLow, end: rmssdHigh, color: 'var(--green)' },
          { start: rmssdHigh, end: 120, color: 'var(--blue)' },
        ],
        markerColor: m.rmssd < rmssdLow ? 'var(--red)' : m.rmssd > rmssdHigh ? 'var(--blue)' : 'var(--green)'
      },
      {
        name: 'Stress-Index', value: m.stressIndex, unit: '',
        min: 0, max: 800,
        zones: [
          { start: 0, end: siLow, color: 'var(--blue)' },
          { start: siLow, end: siNormal, color: 'var(--green)' },
          { start: siNormal, end: siElevated, color: 'var(--yellow)' },
          { start: siElevated, end: 800, color: 'var(--red)' },
        ],
        markerColor: m.stressIndex < siLow ? 'var(--blue)' : m.stressIndex < siNormal ? 'var(--green)' : m.stressIndex < siElevated ? 'var(--yellow)' : 'var(--red)'
      },
      {
        name: 'Ruhe-HF', value: m.meanHR, unit: 'bpm',
        min: 35, max: 110,
        zones: [
          { start: 35, end: 60, color: 'var(--blue)' },
          { start: 60, end: 100, color: 'var(--green)' },
          { start: 100, end: 110, color: 'var(--red)' },
        ],
        markerColor: m.meanHR < 60 ? 'var(--blue)' : m.meanHR > 100 ? 'var(--red)' : 'var(--green)'
      },
      {
        name: 'SDNN', value: m.sdnn, unit: 'ms',
        min: 0, max: 150,
        zones: [
          { start: 0, end: 32, color: 'var(--red)' },
          { start: 32, end: 93, color: 'var(--green)' },
          { start: 93, end: 150, color: 'var(--blue)' },
        ],
        markerColor: m.sdnn < 32 ? 'var(--red)' : m.sdnn > 93 ? 'var(--blue)' : 'var(--green)'
      }
    ];

    const barsHtml = items.map(it => {
      const range = it.max - it.min;
      const pct = Math.max(0, Math.min(100, ((it.value - it.min) / range) * 100));
      const zonesHtml = it.zones.map(z => {
        const left = ((z.start - it.min) / range) * 100;
        const width = ((z.end - z.start) / range) * 100;
        return `<div class="snapshot-bar-zone" style="left:${left}%;width:${width}%;background:${z.color}"></div>`;
      }).join('');

      return `
        <div class="snapshot-item">
          <div class="snapshot-item-label">
            <span class="snapshot-item-name">${it.name}</span>
            <span class="snapshot-item-value">${it.value}<span class="metric-unit">${it.unit}</span></span>
          </div>
          <div class="snapshot-bar-track">
            ${zonesHtml}
            <div class="snapshot-bar-marker" style="left:${pct}%;background:${it.markerColor}"></div>
          </div>
        </div>
      `;
    }).join('');

    document.getElementById('snapshot').innerHTML = `
      <div class="snapshot-header">
        <div class="snapshot-badge ${badge}">${badgeIcon}</div>
        <div class="snapshot-headline">${headline}<small>${subline}</small></div>
      </div>
      <div class="snapshot-bars">${barsHtml}</div>
    `;
  },

  renderInterpretation(sections) {
    const container = document.getElementById('interpretation');
    const iconMap = {
      good: '✓', warn: '!', neutral: '~', ok: '✓', info: 'i',
      heart: '♥', freq: '∿', stress: '◉', trend: '↗'
    };
    const styleMap = {
      good: 'good', warn: 'warn', neutral: 'neutral',
      ok: 'ok', info: 'info',
      heart: 'ok', freq: 'neutral', stress: 'neutral', trend: 'ok'
    };

    container.innerHTML = sections.map(s => {
      // Convert markdown-style bold and italic to HTML
      const html = s.content
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>');

      return `
        <div class="interpretation-section">
          <div class="interpretation-section-header">
            <div class="interpretation-icon ${styleMap[s.icon] || 'info'}">${iconMap[s.icon] || 'i'}</div>
            <div class="interpretation-section-title">${s.title}</div>
          </div>
          <div class="interpretation-body">${html}</div>
        </div>
      `;
    }).join('');
  },

  renderMetrics(containerId, metrics, comparison) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    for (const { key, label, value, unit } of metrics) {
      if (value == null) continue;
      const card = document.createElement('div');
      card.className = 'metric-card';

      let compHtml = '';
      const c = comparison[key];
      if (c) {
        const sign = c.deviation > 0 ? '+' : '';
        if (c.questionable) {
          compHtml = `<div class="metric-comparison neutral" title="Extreme Abweichung — zu wenige Vergleichsdaten für zuverlässigen Vergleich">${sign}${c.deviation}% vs. ⌀ ${c.average} ⚠</div>`;
        } else {
          compHtml = `<div class="metric-comparison ${c.rating}">${sign}${c.deviation}% vs. ⌀ ${c.average}</div>`;
        }
      }

      card.innerHTML = `
        <div class="metric-label">${label}</div>
        <div class="metric-value">${value}<span class="metric-unit">${unit}</span></div>
        ${compHtml}
      `;
      container.appendChild(card);
    }
  },

  // ── History ──

  showHistory() {
    this.setState('HISTORY');
    const history = Storage.getAll();

    // Trend charts
    const trendContainer = document.getElementById('trend-charts');
    trendContainer.innerHTML = '';

    const trendMetrics = [
      { key: 'rmssd', label: 'RMSSD (ms)', color: '#6366f1' },
      { key: 'sdnn', label: 'SDNN (ms)', color: '#60a5fa' },
      { key: 'hfPower', label: 'HF Power (ms²)', color: '#4ade80' },
      { key: 'stressIndex', label: 'Stress Index', color: '#f87171' }
    ];

    for (const tm of trendMetrics) {
      const data = getTrendData(history, tm.key);
      if (data.values.length < 2) continue;

      const div = document.createElement('div');
      div.className = 'trend-chart';
      div.innerHTML = `<h3>${tm.label}</h3><canvas></canvas>`;
      trendContainer.appendChild(div);

      const canvas = div.querySelector('canvas');
      new Chart(canvas, {
        type: 'line',
        data: {
          labels: data.labels,
          datasets: [{
            data: data.values,
            borderColor: tm.color,
            backgroundColor: tm.color + '20',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            pointHoverRadius: 5,
            borderWidth: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8b8fa3', maxTicksLimit: 6, font: { size: 10 } }, grid: { color: '#2a2e3a' } },
            y: { ticks: { color: '#8b8fa3', font: { size: 10 } }, grid: { color: '#2a2e3a' } }
          }
        }
      });
    }

    // Measurement list
    const listEl = document.getElementById('measurement-list');
    listEl.innerHTML = '';

    if (history.length === 0) {
      listEl.innerHTML = '<div class="history-empty">Noch keine Messungen vorhanden.</div>';
      return;
    }

    for (const m of history) {
      const item = document.createElement('div');
      item.className = 'measurement-item';
      item.addEventListener('click', () => this.showResults(m));

      const date = new Date(m.timestamp).toLocaleString('de-DE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });

      item.innerHTML = `
        <div class="measurement-info">
          <div class="measurement-date">${date}</div>
          <div class="measurement-summary">
            HR ${m.metrics.meanHR} bpm · SDNN ${m.metrics.sdnn} ms · Stress ${m.metrics.stressIndex}
          </div>
        </div>
        <div>
          <div class="measurement-rmssd">${m.metrics.rmssd}</div>
          <div class="measurement-rmssd-label">RMSSD</div>
        </div>
      `;
      listEl.appendChild(item);
    }
  },

  // ── Charts ──

  initLiveHRChart() {
    this.destroyChart('liveHR');
    const ctx = document.getElementById('chart-livehr').getContext('2d');
    this.charts.liveHR = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: '#f87171',
          backgroundColor: 'rgba(248, 113, 113, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 0,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: {
            min: 40, max: 140,
            ticks: { color: '#8b8fa3' },
            grid: { color: '#2a2e3a' }
          }
        }
      }
    });
  },

  updateLiveHRChart() {
    if (!this.charts.liveHR) return;
    const labels = this.hrBuffer.map(p => {
      const s = Math.floor((p.time - this.hrBuffer[0].time) / 1000);
      return s + 's';
    });
    this.charts.liveHR.data.labels = labels;
    this.charts.liveHR.data.datasets[0].data = this.hrBuffer.map(p => p.hr);

    // Dynamic y-axis
    const hrs = this.hrBuffer.map(p => p.hr);
    const minHR = Math.min(...hrs);
    const maxHR = Math.max(...hrs);
    this.charts.liveHR.options.scales.y.min = Math.max(30, minHR - 10);
    this.charts.liveHR.options.scales.y.max = maxHR + 10;

    this.charts.liveHR.update();
  },

  initPoincareLiveChart() {
    this.destroyChart('poincareLive');
    const ctx = document.getElementById('chart-poincare-live').getContext('2d');
    this.charts.poincareLive = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          data: [],
          backgroundColor: 'rgba(99, 102, 241, 0.5)',
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        animation: { duration: 0 },
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'RR[n] (ms)', color: '#8b8fa3' }, ticks: { color: '#8b8fa3' }, grid: { color: '#2a2e3a' } },
          y: { title: { display: true, text: 'RR[n+1] (ms)', color: '#8b8fa3' }, ticks: { color: '#8b8fa3' }, grid: { color: '#2a2e3a' } }
        }
      }
    });
  },

  updatePoincareLive() {
    if (!this.charts.poincareLive || this.rrBuffer.length < 2) return;
    // Throttle updates
    if (this._lastPoincareUpdate && Date.now() - this._lastPoincareUpdate < 1000) return;
    this._lastPoincareUpdate = Date.now();

    const data = [];
    for (let i = 0; i < this.rrBuffer.length - 1; i++) {
      data.push({ x: Math.round(this.rrBuffer[i]), y: Math.round(this.rrBuffer[i + 1]) });
    }
    this.charts.poincareLive.data.datasets[0].data = data;
    this.charts.poincareLive.update();
  },

  renderPoincareChart(xData, yData) {
    this.destroyChart('poincare');
    const ctx = document.getElementById('chart-poincare').getContext('2d');
    const data = xData.map((x, i) => ({ x: Math.round(x), y: Math.round(yData[i]) }));

    this.charts.poincare = new Chart(ctx, {
      type: 'scatter',
      data: {
        datasets: [{
          data,
          backgroundColor: 'rgba(99, 102, 241, 0.6)',
          pointRadius: 3,
          pointHoverRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { title: { display: true, text: 'RR[n] (ms)', color: '#8b8fa3' }, ticks: { color: '#8b8fa3' }, grid: { color: '#2a2e3a' } },
          y: { title: { display: true, text: 'RR[n+1] (ms)', color: '#8b8fa3' }, ticks: { color: '#8b8fa3' }, grid: { color: '#2a2e3a' } }
        }
      }
    });
  },

  renderPSDChart(freqs, values) {
    this.destroyChart('psd');
    if (!freqs || freqs.length === 0) return;

    const ctx = document.getElementById('chart-psd').getContext('2d');

    // Color segments: LF = blue, HF = green
    const colors = freqs.map(f => {
      if (f >= 0.04 && f <= 0.15) return 'rgba(96, 165, 250, 0.6)';
      if (f > 0.15 && f <= 0.4) return 'rgba(74, 222, 128, 0.6)';
      return 'rgba(139, 143, 163, 0.3)';
    });

    this.charts.psd = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: freqs.map(f => f.toFixed(2)),
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 0,
          barPercentage: 1.0,
          categoryPercentage: 1.0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => `${items[0].label} Hz`,
              label: (item) => `Power: ${item.raw.toExponential(2)}`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'Frequenz (Hz)', color: '#8b8fa3' },
            ticks: {
              color: '#8b8fa3',
              maxTicksLimit: 10,
              callback: function(val, i) {
                const f = parseFloat(this.getLabelForValue(i));
                return (f * 100) % 5 === 0 ? f.toFixed(2) : '';
              }
            },
            grid: { color: '#2a2e3a' }
          },
          y: {
            title: { display: true, text: 'PSD', color: '#8b8fa3' },
            ticks: { color: '#8b8fa3' },
            grid: { color: '#2a2e3a' },
            type: 'logarithmic'
          }
        }
      }
    });
  },

  destroyChart(name) {
    if (this.charts[name]) {
      this.charts[name].destroy();
      this.charts[name] = null;
    }
  },

  // ── Utils ──

  reset() {
    this.monitor.disconnect();
    this.destroyChart('liveHR');
    this.destroyChart('poincareLive');
    this.destroyChart('poincare');
    this.destroyChart('psd');
    this.rrBuffer = [];
    this.hrBuffer = [];
    this.currentResults = null;

    // Update history link visibility
    if (Storage.getAll().length > 0) {
      document.getElementById('btn-history-landing').style.display = '';
    }

    this.setState('LANDING');
  },

  exportData() {
    const json = Storage.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hrv-daten-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
};

// ── State mapping helper ──
const stateViewMap = {
  LANDING: 'landing',
  CONNECTING: 'connecting',
  LIVE_HR: 'livehr',
  MEASURING: 'measuring',
  RESULTS: 'results',
  HISTORY: 'history'
};

// Override setState with proper mapping
App.setState = function(newState) {
  this.state = newState;
  const target = stateViewMap[newState];
  const views = Object.values(stateViewMap);
  for (const v of views) {
    document.getElementById(`view-${v}`).classList.toggle('active', v === target);
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
