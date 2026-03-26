// ── Artifact Correction ──

function correctArtifacts(rrIntervals) {
  const rr = [...rrIntervals];
  const windowSize = 5;
  const threshold = 0.20;
  const artifacts = [];

  for (let i = 0; i < rr.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(rr.length, i + Math.ceil(windowSize / 2) + 1);
    const window = [];
    for (let j = start; j < end; j++) {
      if (j !== i) window.push(rr[j]);
    }
    window.sort((a, b) => a - b);
    const median = window[Math.floor(window.length / 2)];

    if (Math.abs(rr[i] - median) / median > threshold) {
      artifacts.push(i);
      const prev = i > 0 ? rr[i - 1] : median;
      const next = i < rr.length - 1 ? rr[i + 1] : median;
      rr[i] = (prev + next) / 2;
    }
  }

  return { corrected: rr, artifactCount: artifacts.length, artifactIndices: artifacts };
}

// ── Time Domain ──

function timeDomain(nn) {
  const n = nn.length;
  const meanRR = nn.reduce((s, v) => s + v, 0) / n;
  const meanHR = 60000 / meanRR;

  const sdnn = Math.sqrt(nn.reduce((s, v) => s + (v - meanRR) ** 2, 0) / n);

  const diffs = [];
  for (let i = 1; i < n; i++) {
    diffs.push(nn[i] - nn[i - 1]);
  }

  const rmssd = Math.sqrt(diffs.reduce((s, d) => s + d * d, 0) / diffs.length);
  const nn50 = diffs.filter(d => Math.abs(d) > 50).length;
  const pnn50 = (nn50 / diffs.length) * 100;

  const minRR = Math.min(...nn);
  const maxRR = Math.max(...nn);

  return {
    meanRR: +meanRR.toFixed(1),
    meanHR: +meanHR.toFixed(1),
    sdnn: +sdnn.toFixed(1),
    rmssd: +rmssd.toFixed(1),
    nn50,
    pnn50: +pnn50.toFixed(1),
    minHR: +(60000 / maxRR).toFixed(1),
    maxHR: +(60000 / minRR).toFixed(1)
  };
}

// ── FFT (Radix-2 Cooley-Tukey) ──

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const tmpRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = tmpRe;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function linearInterpolate(times, values, fs, nSamples) {
  const result = new Float64Array(nSamples);
  let j = 0;
  for (let i = 0; i < nSamples; i++) {
    const t = i / fs;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const t0 = times[j], t1 = times[j + 1];
    const v0 = values[j], v1 = values[j + 1];
    const frac = t1 !== t0 ? (t - t0) / (t1 - t0) : 0;
    result[i] = v0 + frac * (v1 - v0);
  }
  return result;
}

// ── Frequency Domain ──

function frequencyDomain(nn) {
  if (nn.length < 30) {
    return { lfPower: 0, hfPower: 0, totalPower: 0, lfHfRatio: null, psdFreqs: [], psdValues: [] };
  }

  const times = [0];
  for (let i = 1; i < nn.length; i++) {
    times.push(times[i - 1] + nn[i] / 1000);
  }

  const fs = 4;
  const duration = times[times.length - 1];
  const nSamples = Math.floor(duration * fs);
  if (nSamples < 16) {
    return { lfPower: 0, hfPower: 0, totalPower: 0, lfHfRatio: null, psdFreqs: [], psdValues: [] };
  }

  const interpolated = linearInterpolate(times, nn, fs, nSamples);

  const mean = interpolated.reduce((s, v) => s + v, 0) / nSamples;
  const nfft = nextPow2(nSamples);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < nSamples; i++) {
    const hann = 0.5 * (1 - Math.cos(2 * Math.PI * i / (nSamples - 1)));
    re[i] = (interpolated[i] - mean) * hann;
  }

  fft(re, im);

  const freqRes = fs / nfft;
  const halfN = nfft / 2 + 1;
  const psd = new Float64Array(halfN);
  for (let i = 0; i < halfN; i++) {
    psd[i] = (re[i] ** 2 + im[i] ** 2) / (fs * nfft);
    if (i > 0 && i < nfft / 2) psd[i] *= 2;
  }

  let lfPower = 0, hfPower = 0, totalPower = 0;
  for (let i = 0; i < halfN; i++) {
    const freq = i * freqRes;
    if (freq >= 0.04 && freq <= 0.15) lfPower += psd[i] * freqRes;
    if (freq > 0.15 && freq <= 0.4) hfPower += psd[i] * freqRes;
    if (freq >= 0.003 && freq <= 0.4) totalPower += psd[i] * freqRes;
  }

  const psdFreqs = [];
  const psdValues = [];
  for (let i = 0; i < halfN; i++) {
    const freq = i * freqRes;
    if (freq <= 0.5) {
      psdFreqs.push(+freq.toFixed(4));
      psdValues.push(psd[i]);
    }
  }

  return {
    lfPower: Math.round(lfPower),
    hfPower: Math.round(hfPower),
    totalPower: Math.round(totalPower),
    lfHfRatio: hfPower > 0 ? +(lfPower / hfPower).toFixed(2) : null,
    lfNorm: totalPower > 0 ? +((lfPower / (lfPower + hfPower)) * 100).toFixed(1) : null,
    hfNorm: totalPower > 0 ? +((hfPower / (lfPower + hfPower)) * 100).toFixed(1) : null,
    psdFreqs,
    psdValues
  };
}

// ── Non-Linear ──

function variance(arr) {
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
}

function nonLinear(nn) {
  const diffs = [];
  const sums = [];
  for (let i = 0; i < nn.length - 1; i++) {
    diffs.push(nn[i + 1] - nn[i]);
    sums.push(nn[i + 1] + nn[i]);
  }

  const sd1 = Math.sqrt(variance(diffs) / 2);
  const sd2 = Math.sqrt(variance(sums) / 2);

  // Stress Index (Baevsky)
  const binSize = 50;
  const bins = {};
  nn.forEach(rr => {
    const bin = Math.round(rr / binSize) * binSize;
    bins[bin] = (bins[bin] || 0) + 1;
  });
  const modeBin = Object.entries(bins).sort((a, b) => b[1] - a[1])[0];
  const mo = parseFloat(modeBin[0]) / 1000;
  const amo = (modeBin[1] / nn.length) * 100;
  const mxdmn = (Math.max(...nn) - Math.min(...nn)) / 1000;

  const stressIndex = mxdmn > 0 ? amo / (2 * mo * mxdmn) : 0;

  return {
    sd1: +sd1.toFixed(1),
    sd2: +sd2.toFixed(1),
    sd1sd2Ratio: sd2 > 0 ? +(sd1 / sd2).toFixed(3) : null,
    stressIndex: +stressIndex.toFixed(1),
    poincareX: nn.slice(0, -1),
    poincareY: nn.slice(1)
  };
}

// ── Main Export ──

export function calculateHRV(rawRRIntervals) {
  const { corrected, artifactCount } = correctArtifacts(rawRRIntervals);
  const time = timeDomain(corrected);
  const freq = frequencyDomain(corrected);
  const nl = nonLinear(corrected);

  return {
    ...time,
    ...freq,
    ...nl,
    artifactCount,
    artifactPercent: +((artifactCount / rawRRIntervals.length) * 100).toFixed(1),
    totalBeats: rawRRIntervals.length,
    duration: +(rawRRIntervals.reduce((s, v) => s + v, 0) / 1000).toFixed(1)
  };
}
