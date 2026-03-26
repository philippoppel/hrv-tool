const STORAGE_KEY = 'hrv_measurements';

function getAll() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

function save(measurement) {
  const all = getAll();
  all.push(measurement);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function getById(id) {
  return getAll().find(m => m.id === id) || null;
}

function remove(id) {
  const all = getAll().filter(m => m.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

function exportJSON() {
  return JSON.stringify(getAll(), null, 2);
}

function importJSON(json) {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('Ungültiges Format');
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getAverages(excludeId) {
  let all = getAll();
  if (excludeId) all = all.filter(m => m.id !== excludeId);
  if (all.length === 0) return null;

  const keys = ['meanRR', 'meanHR', 'sdnn', 'rmssd', 'pnn50', 'lfPower', 'hfPower', 'lfHfRatio', 'sd1', 'sd2', 'stressIndex'];
  const avgs = {};

  for (const key of keys) {
    const values = all.map(m => m.metrics?.[key]).filter(v => v != null && !isNaN(v));
    avgs[key] = values.length > 0 ? +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(1) : null;
  }

  return avgs;
}

export const Storage = { getAll, save, getById, remove, exportJSON, importJSON, getAverages };
