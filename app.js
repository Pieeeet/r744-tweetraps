import CoolPropFactory from './coolprop.js';

const FLUID = 'CO2';
const CACHE_KEY = 'r744-ph-lines-v5-coolprop-8';
const CRITICAL = { t: 304.1282, p: 7.3773e6 };
const NS = 'http://www.w3.org/2000/svg';

const controls = [
  { id: 'evapC', label: 'Verdamping', min: -45, max: 5, step: 1, value: -30, unit: '°C' },
  { id: 'receiverBar', label: 'Receiverdruk', min: 20, max: 55, step: 1, value: 35, unit: 'bar(a)' },
  { id: 'highBar', label: 'Hogedruk', min: 76, max: 130, step: 1, value: 90, unit: 'bar(a)' },
  { id: 'gasOutC', label: 'Gaskoeler uit', min: 20, max: 55, step: 1, value: 32, unit: '°C' },
  { id: 'superheatK', label: 'Oververhitting', min: 1, max: 20, step: 1, value: 8, unit: 'K' },
  { id: 'intercoolApproachK', label: 'Intercooler boven Tₛₐₜ', min: 2, max: 25, step: 1, value: 5, unit: 'K' },
  { id: 'etaLpPct', label: 'η lage trap', min: 45, max: 85, step: 1, value: 70, unit: '%' },
  { id: 'etaHpPct', label: 'η hoge trap', min: 45, max: 85, step: 1, value: 70, unit: '%' },
  { id: 'capacityKw', label: 'Koelvermogen', min: 2, max: 200, step: 1, value: 30, unit: 'kW' }
];

const presets = {
  freezer: { evapC: -35, receiverBar: 34, highBar: 90, gasOutC: 32, superheatK: 8, intercoolApproachK: 5, etaLpPct: 70, etaHpPct: 70, capacityKw: 30 },
  medium: { evapC: -10, receiverBar: 40, highBar: 88, gasOutC: 30, superheatK: 6, intercoolApproachK: 5, etaLpPct: 72, etaHpPct: 72, capacityKw: 50 },
  warm: { evapC: -30, receiverBar: 38, highBar: 105, gasOutC: 42, superheatK: 8, intercoolApproachK: 7, etaLpPct: 68, etaHpPct: 68, capacityKw: 30 }
};

const stateNames = [
  'LP-compressor in', 'LP-compressor uit', 'Intercooler uit', 'Receiver: verzadigde damp',
  'HP-compressor in (menging)', 'HP-compressor uit', 'Gaskoeler uit',
  'HP-ventiel uit / receiver in', 'Receiver: verzadigde vloeistof', 'LP-ventiel uit / verdamper in'
];

const stateNotes = [
  'oververhitte verdamperdamp', 'na isentroop rendement', 'gekoeld tot Tₛₐₜ + benadering',
  'flashgas-bypass', 'LP-stroom + flashgas', 'transkritische persgasstroom', 'hogedrukvloeistof / dichte fase',
  'iso-enthalpische expansie', 'vloeistof naar LP-ventiel', 'tweefasenmengsel'
];

const ui = {};
let CP = null;
let lastResult = null;
let recalcTimer = null;
let diagramData = loadDiagramCache();
const generating = new Set();

function byId(id) { return document.getElementById(id); }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function fmt(v, digits = 1) { return Number.isFinite(v) ? v.toLocaleString('nl-BE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—'; }
function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => resolve())); }
function idle() { return new Promise(resolve => (window.requestIdleCallback || ((fn) => setTimeout(fn, 12)))(() => resolve(), { timeout: 80 })); }

function setRuntime(text, state = 'loading', progress = 0) {
  byId('runtimeText').textContent = text;
  byId('runtime').className = `runtime ${state}`;
  byId('loadingBar').style.width = `${clamp(progress, 0, 100)}%`;
}

function showMessage(text, type = 'error') {
  const box = byId('message');
  box.textContent = text;
  box.className = `message ${type}`;
}

function hideMessage() { byId('message').className = 'message hidden'; }

function renderControls() {
  const host = byId('controls');
  host.innerHTML = '';
  for (const spec of controls) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `
      <div class="control-head"><label for="${spec.id}">${spec.label}</label><output class="control-output" id="${spec.id}Out"></output></div>
      <input id="${spec.id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.value}">
      <div class="control-scale"><span>${spec.min}</span><span>${spec.max} ${spec.unit}</span></div>`;
    host.appendChild(wrap);
    const input = byId(spec.id);
    ui[spec.id] = input;
    input.addEventListener('input', () => {
      updateControlOutput(spec);
      scheduleCycle();
    });
    updateControlOutput(spec);
  }
}

function updateControlOutput(spec) {
  byId(`${spec.id}Out`).textContent = `${fmt(Number(ui[spec.id].value), spec.step < 1 ? 1 : 0)} ${spec.unit}`;
}

function values() {
  return Object.fromEntries(controls.map(spec => [spec.id, Number(ui[spec.id].value)]));
}

function applyValues(next) {
  controls.forEach(spec => {
    if (next[spec.id] !== undefined) ui[spec.id].value = next[spec.id];
    updateControlOutput(spec);
  });
  scheduleCycle(true);
}

function prop(output, input1, value1, input2, value2) {
  if (!CP?.PropsSI) throw new Error('CoolProp PropsSI is niet beschikbaar.');
  const result = CP.PropsSI(output, input1, value1, input2, value2, FLUID);
  if (!Number.isFinite(result) || Math.abs(result) > 1e50) {
    throw new Error(`CoolProp gaf geen geldige waarde voor ${output}(${input1}, ${input2}).`);
  }
  return result;
}

function statePH(index, p, h, extra = {}) {
  return {
    index, p, h,
    t: prop('T', 'P', p, 'H', h),
    s: prop('S', 'P', p, 'H', h),
    ...extra
  };
}

function statePT(index, p, t, extra = {}) {
  const h = prop('H', 'P', p, 'T', t);
  return { index, p, t, h, s: prop('S', 'P', p, 'T', t), ...extra };
}

function calculateCycle(input) {
  const tEvapSat = input.evapC + 273.15;
  const pEvap = prop('P', 'T', tEvapSat, 'Q', 1);
  const pReceiver = input.receiverBar * 1e5;
  const pHigh = input.highBar * 1e5;
  const etaLp = input.etaLpPct / 100;
  const etaHp = input.etaHpPct / 100;

  if (pReceiver <= pEvap * 1.05) throw new Error(`Receiverdruk moet hoger zijn dan de verdampingsdruk (${fmt(pEvap / 1e5, 1)} bar(a)).`);
  if (pReceiver >= CRITICAL.p * 0.99) throw new Error('De receiver moet onder de kritische druk van R744 blijven.');
  if (pHigh <= CRITICAL.p || pHigh <= pReceiver * 1.15) throw new Error('De hogedruk moet transkritisch en duidelijk hoger dan de receiverdruk zijn.');

  // 1: evaporator outlet / LP suction
  const s1 = statePT(1, pEvap, tEvapSat + input.superheatK);

  // 2: LP discharge
  const h2s = prop('H', 'P', pReceiver, 'S', s1.s);
  const h2 = s1.h + (h2s - s1.h) / etaLp;
  const s2 = statePH(2, pReceiver, h2);

  // 3: intercooler outlet, approached from the superheated-vapour side
  const tReceiverSat = prop('T', 'P', pReceiver, 'Q', 1);
  const targetT3 = tReceiverSat + input.intercoolApproachK;
  const actualT3 = Math.min(targetT3, s2.t - 0.05);
  const s3 = statePT(3, pReceiver, actualT3, { limitedIntercooling: targetT3 >= s2.t });

  // 4 and 9: receiver equilibrium outlets
  const h4 = prop('H', 'P', pReceiver, 'Q', 1);
  const s4 = statePH(4, pReceiver, h4, { quality: 1 });
  const h9 = prop('H', 'P', pReceiver, 'Q', 0);
  const s9 = statePH(9, pReceiver, h9, { quality: 0 });

  // 7 and 8: gas-cooler outlet and throttled receiver inlet
  const s7 = statePT(7, pHigh, input.gasOutC + 273.15);
  const s8 = statePH(8, pReceiver, s7.h);
  const flashQuality = prop('Q', 'P', pReceiver, 'H', s7.h);
  if (!(flashQuality > 0 && flashQuality < 0.92)) {
    throw new Error('De expansie naar de receiver levert geen bruikbaar tweefasenmengsel. Pas hogedruk, gaskoeler-uitlaat of receiverdruk aan.');
  }
  s8.quality = flashQuality;

  // 10: liquid outlet throttled to evaporating pressure
  const s10 = statePH(10, pEvap, h9);
  const q10 = prop('Q', 'P', pEvap, 'H', h9);
  if (q10 >= 0 && q10 <= 1) s10.quality = q10;

  // Receiver mass balance: m_liquid = (1-x8) m_high = m_low
  const qEvapSpecific = s1.h - s10.h;
  if (qEvapSpecific <= 0) throw new Error('Geen positief specifiek koelvermogen voor deze instellingen.');
  const qCooling = input.capacityKw * 1000;
  const mLow = qCooling / qEvapSpecific;
  const mHigh = mLow / (1 - flashQuality);
  const mFlash = mHigh - mLow;

  // 5: adiabatic mixing at receiver pressure
  const h5 = (mLow * s3.h + mFlash * s4.h) / mHigh;
  const s5 = statePH(5, pReceiver, h5);

  // 6: HP discharge
  const h6s = prop('H', 'P', pHigh, 'S', s5.s);
  const h6 = s5.h + (h6s - s5.h) / etaHp;
  const s6 = statePH(6, pHigh, h6);

  const wLp = mLow * (s2.h - s1.h);
  const wHp = mHigh * (s6.h - s5.h);
  const qIntercooler = Math.max(0, mLow * (s2.h - s3.h));
  const qGasCooler = mHigh * (s6.h - s7.h);
  const balanceResidual = qCooling + wLp + wHp - qIntercooler - qGasCooler;
  const balanceError = Math.abs(balanceResidual) / Math.max(qCooling + wLp + wHp, 1);
  const states = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10];

  const warnings = [];
  const ratioLp = pReceiver / pEvap;
  const ratioHp = pHigh / pReceiver;
  if (ratioLp > 4.5 || ratioHp > 4.5) warnings.push('Een drukverhouding is hoger dan 4,5; controleer compressorkeuze en persgastemperatuur.');
  if (s6.t > 423.15) warnings.push(`Hoge persgastemperatuur: ${fmt(s6.t - 273.15, 0)} °C.`);
  if (s3.limitedIntercooling) warnings.push('De ingestelde intercoolerbenadering ligt boven de LP-persgastemperatuur; de intercooler is begrensd.');
  if (flashQuality > 0.45) warnings.push(`Hoog flashgaspercentage: ${fmt(flashQuality * 100, 0)}%.`);

  return {
    input, states, pEvap, pReceiver, pHigh, flashQuality, mLow, mHigh, mFlash,
    qCooling, qIntercooler, qGasCooler, wLp, wHp,
    cop: qCooling / (wLp + wHp), balanceError, ratioLp, ratioHp, warnings
  };
}

function scheduleCycle(immediate = false) {
  if (!CP) return;
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(runCycle, immediate ? 0 : 110);
}

function runCycle() {
  try {
    const result = calculateCycle(values());
    lastResult = result;
    hideMessage();
    renderResult(result);
    if (result.warnings.length) showMessage(result.warnings.join(' '), 'warning');
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function renderResult(r) {
  byId('metricCop').textContent = fmt(r.cop, 2);
  byId('metricPower').textContent = `${fmt((r.wLp + r.wHp) / 1000, 1)} kW`;
  byId('metricPowerDetail').textContent = `${fmt(r.wLp / 1000, 1)} + ${fmt(r.wHp / 1000, 1)} kW`;
  byId('metricFlow').textContent = `${fmt(r.mLow, 3)} kg/s`;
  byId('metricFlowDetail').textContent = `${fmt(r.mLow, 3)} → ${fmt(r.mHigh, 3)} kg/s`;
  byId('metricFlash').textContent = `${fmt(r.flashQuality * 100, 1)} %`;
  byId('metricHeat').textContent = `${fmt((r.qIntercooler + r.qGasCooler) / 1000, 1)} kW`;
  byId('metricHeatDetail').textContent = `${fmt(r.qIntercooler / 1000, 1)} + ${fmt(r.qGasCooler / 1000, 1)} kW`;
  byId('balanceCooling').textContent = `${fmt(r.qCooling / 1000, 1)} kW`;
  byId('balanceIntercooler').textContent = `${fmt(r.qIntercooler / 1000, 1)} kW`;
  byId('balanceGasCooler').textContent = `${fmt(r.qGasCooler / 1000, 1)} kW`;
  byId('balanceError').textContent = `${fmt(r.balanceError * 100, 3)} %`;
  renderStateTable(r.states);
  byId('chartEmpty').classList.add('hidden');
  renderChart();
}

function renderStateTable(states) {
  const tbody = byId('stateRows');
  tbody.innerHTML = states.map((s, i) => {
    const note = s.quality !== undefined && s.quality >= 0 && s.quality <= 1
      ? `${stateNotes[i]} · x=${fmt(s.quality, 3)}` : stateNotes[i];
    return `<tr>
      <td><span class="point-pill">${s.index}</span></td>
      <td>${stateNames[i]}</td>
      <td>${fmt(s.p / 1e5, 2)}</td>
      <td>${fmt(s.t - 273.15, 1)}</td>
      <td>${fmt(s.h / 1000, 1)}</td>
      <td>${fmt(s.s / 1000, 3)}</td>
      <td>${note}</td>
    </tr>`;
  }).join('');
}

function loadDiagramCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}

function saveDiagramCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(diagramData)); } catch { /* private mode or quota */ }
}

function logspace(min, max, count) {
  const a = Math.log(min), b = Math.log(max);
  return Array.from({ length: count }, (_, i) => Math.exp(a + (b - a) * i / (count - 1)));
}

function splitValidPoints(points, jumpLimit = 95) {
  const segments = [];
  let current = [];
  for (const point of points) {
    const previous = current[current.length - 1];
    if (!point || (previous && Math.abs(point.h - previous.h) > jumpLimit)) {
      if (current.length > 1) segments.push(current);
      current = point ? [point] : [];
    } else current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

async function ensureDiagramFamily(family) {
  if (!CP || diagramData[family] || generating.has(family)) return;
  generating.add(family);
  try {
    if (family === 'dome') diagramData.dome = await generateDome();
    if (family === 'isotherms') diagramData.isotherms = await generateIsotherms();
    if (family === 'isentropes') diagramData.isentropes = await generateIsentropes();
    if (family === 'quality') diagramData.quality = await generateQualityLines();
    saveDiagramCache();
    renderChart();
  } finally {
    generating.delete(family);
  }
}

async function generateDome() {
  const liquid = [], vapour = [];
  const temperatures = Array.from({ length: 38 }, (_, i) => 218.0 + (CRITICAL.t - 218.6) * i / 37);
  for (let i = 0; i < temperatures.length; i++) {
    const t = temperatures[i];
    try {
      const p = prop('P', 'T', t, 'Q', 0) / 1e5;
      liquid.push({ h: prop('H', 'T', t, 'Q', 0) / 1000, p });
      vapour.push({ h: prop('H', 'T', t, 'Q', 1) / 1000, p });
    } catch { /* skip near limits */ }
    if (i % 5 === 0) { setRuntime('Cyclus gereed · verzadigingskoepel berekenen…', 'ready', 78 + i / temperatures.length * 7); await idle(); }
  }
  return { liquid, vapour };
}

async function generateIsotherms() {
  const temperatures = [-40, -20, 0, 20, 40, 60, 80, 100, 120];
  const pressures = logspace(5.5, 140, 20);
  const lines = [];
  for (let ti = 0; ti < temperatures.length; ti++) {
    const tC = temperatures[ti];
    const raw = [];
    for (const pBar of pressures) {
      try { raw.push({ h: prop('H', 'T', tC + 273.15, 'P', pBar * 1e5) / 1000, p: pBar }); }
      catch { raw.push(null); }
    }
    splitValidPoints(raw).forEach((points, index) => lines.push({ label: index === 0 ? `${tC} °C` : '', points }));
    setRuntime(`Cyclus gereed · isothermen ${ti + 1}/${temperatures.length}`, 'ready', 85 + (ti + 1) / temperatures.length * 10);
    await idle();
  }
  return lines;
}

async function generateIsentropes() {
  const entropies = [1.4, 1.7, 2.0, 2.3, 2.6];
  const pressures = logspace(6, 140, 18);
  const lines = [];
  for (let si = 0; si < entropies.length; si++) {
    const s = entropies[si];
    const raw = pressures.map(pBar => {
      try { return { h: prop('H', 'P', pBar * 1e5, 'S', s * 1000) / 1000, p: pBar }; }
      catch { return null; }
    });
    splitValidPoints(raw).forEach((points, index) => lines.push({ label: index === 0 ? `s=${s}` : '', points }));
    await idle();
  }
  return lines;
}

async function generateQualityLines() {
  const qualities = [0.2, 0.4, 0.6, 0.8];
  const temperatures = Array.from({ length: 28 }, (_, i) => 218.5 + (CRITICAL.t - 219.2) * i / 27);
  const lines = [];
  for (let qi = 0; qi < qualities.length; qi++) {
    const q = qualities[qi];
    const points = [];
    for (const t of temperatures) {
      try { points.push({ h: prop('H', 'T', t, 'Q', q) / 1000, p: prop('P', 'T', t, 'Q', q) / 1e5 }); }
      catch { /* skip */ }
    }
    lines.push({ label: `x=${q}`, points });
    await idle();
  }
  return lines;
}

function svgEl(name, attrs = {}, text = '') {
  const el = document.createElementNS(NS, name);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  if (text) el.textContent = text;
  return el;
}

function renderChart() {
  const svg = byId('phChart');
  const width = 1000, height = 590;
  const margin = { left: 72, right: 26, top: 25, bottom: 58 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const hMin = 80, hMax = 600, pMin = 5, pMax = 145;
  const x = h => margin.left + (h - hMin) / (hMax - hMin) * plotW;
  const y = p => margin.top + (Math.log(pMax) - Math.log(clamp(p, pMin, pMax))) / (Math.log(pMax) - Math.log(pMin)) * plotH;
  const pointsAttr = points => points.filter(pt => pt && pt.h >= hMin - 30 && pt.h <= hMax + 30 && pt.p > 0).map(pt => `${x(pt.h).toFixed(1)},${y(pt.p).toFixed(1)}`).join(' ');

  svg.innerHTML = '';
  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: 'plotClip' });
  clip.appendChild(svgEl('rect', { x: margin.left, y: margin.top, width: plotW, height: plotH }));
  defs.appendChild(clip);
  [['chartArrowLp', '#32c7f3'], ['chartArrowHp', '#ffb454'], ['chartArrowFlash', '#b79cff']].forEach(([id, fill]) => {
    const marker = svgEl('marker', { id, markerWidth: 12, markerHeight: 12, refX: 11, refY: 6, orient: 'auto', markerUnits: 'userSpaceOnUse' });
    marker.appendChild(svgEl('path', { d: 'M0 0L12 6L0 12Z', fill }));
    defs.appendChild(marker);
  });
  svg.appendChild(defs);

  const pTicks = [5, 10, 20, 30, 50, 70, 100, 140];
  const hTicks = [100, 200, 300, 400, 500, 600];
  pTicks.forEach(p => {
    svg.appendChild(svgEl('line', { class: 'grid', x1: margin.left, x2: width - margin.right, y1: y(p), y2: y(p) }));
    svg.appendChild(svgEl('text', { x: margin.left - 11, y: y(p) + 4, 'text-anchor': 'end' }, String(p)));
  });
  hTicks.forEach(h => {
    svg.appendChild(svgEl('line', { class: 'grid', x1: x(h), x2: x(h), y1: margin.top, y2: height - margin.bottom }));
    svg.appendChild(svgEl('text', { x: x(h), y: height - margin.bottom + 22, 'text-anchor': 'middle' }, String(h)));
  });
  svg.appendChild(svgEl('line', { class: 'axis', x1: margin.left, x2: margin.left, y1: margin.top, y2: height - margin.bottom }));
  svg.appendChild(svgEl('line', { class: 'axis', x1: margin.left, x2: width - margin.right, y1: height - margin.bottom, y2: height - margin.bottom }));
  svg.appendChild(svgEl('text', { class: 'axis-title', x: margin.left + plotW / 2, y: height - 14, 'text-anchor': 'middle' }, 'Specifieke enthalpie h [kJ/kg]'));
  svg.appendChild(svgEl('text', { class: 'axis-title', x: 18, y: margin.top + plotH / 2, transform: `rotate(-90 18 ${margin.top + plotH / 2})`, 'text-anchor': 'middle' }, 'Absolute druk p [bar] · logaritmisch'));

  const plot = svgEl('g', { 'clip-path': 'url(#plotClip)' });
  const addLineSet = (lines, className) => (lines || []).forEach(line => {
    if (!line.points || line.points.length < 2) return;
    plot.appendChild(svgEl('polyline', { class: className, points: pointsAttr(line.points), 'vector-effect': 'non-scaling-stroke' }));
    if (line.label) {
      const target = line.points[Math.floor(line.points.length * .65)] || line.points[0];
      plot.appendChild(svgEl('text', { class: 'iso-label', x: x(target.h) + 4, y: y(target.p) - 3 }, line.label));
    }
  });

  if (diagramData.dome) {
    plot.appendChild(svgEl('polyline', { class: 'dome-line', points: pointsAttr(diagramData.dome.liquid) }));
    plot.appendChild(svgEl('polyline', { class: 'dome-line', points: pointsAttr(diagramData.dome.vapour) }));
    plot.appendChild(svgEl('circle', { class: 'critical', cx: x(316), cy: y(CRITICAL.p / 1e5), r: 4.5 }));
  }
  if (byId('toggleIsotherms').checked) addLineSet(diagramData.isotherms, 'isotherm');
  if (byId('toggleIsentropes').checked) addLineSet(diagramData.isentropes, 'isentrope');
  if (byId('toggleQuality').checked) addLineSet(diagramData.quality, 'quality');

  if (lastResult) {
    const s = Object.fromEntries(lastResult.states.map(state => [state.index, { h: state.h / 1000, p: state.p / 1e5, index: state.index }]));
    const paths = [
      { cls: 'cycle-lp', marker: 'url(#chartArrowLp)', points: [s[8], s[9], s[10], s[1], s[2], s[3], s[5]] },
      { cls: 'cycle-hp', marker: 'url(#chartArrowHp)', points: [s[5], s[6], s[7], s[8]] },
      { cls: 'cycle-flash', marker: 'url(#chartArrowFlash)', points: [s[8], s[4], s[5]] }
    ];
    paths.forEach(path => plot.appendChild(svgEl('polyline', { class: path.cls, points: pointsAttr(path.points), 'marker-end': path.marker, 'vector-effect': 'non-scaling-stroke' })));
    Object.values(s).forEach(point => {
      plot.appendChild(svgEl('circle', { class: 'state-dot', cx: x(point.h), cy: y(point.p), r: 10 }));
      plot.appendChild(svgEl('text', { class: 'state-number', x: x(point.h), y: y(point.p) + .5 }, String(point.index)));
    });
  }
  svg.appendChild(plot);
}

function exportCsv() {
  if (!lastResult) return;
  const header = ['Punt', 'Locatie', 'p_bar_abs', 'T_C', 'h_kJ_kg', 's_kJ_kgK', 'Opmerking'];
  const rows = lastResult.states.map((s, i) => [s.index, stateNames[i], (s.p / 1e5).toFixed(4), (s.t - 273.15).toFixed(3), (s.h / 1000).toFixed(3), (s.s / 1000).toFixed(5), stateNotes[i]]);
  downloadBlob([header, ...rows].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(';')).join('\n'), 'r744-toestandspunten.csv', 'text/csv;charset=utf-8');
}

function exportSvg() {
  const source = `<?xml version="1.0" encoding="UTF-8"?>\n${byId('phChart').outerHTML}`;
  downloadBlob(source, 'r744-logph-diagram.svg', 'image/svg+xml;charset=utf-8');
}

function downloadBlob(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function bindUi() {
  byId('resetButton').addEventListener('click', () => applyValues(Object.fromEntries(controls.map(c => [c.id, c.value]))));
  document.querySelectorAll('[data-preset]').forEach(button => button.addEventListener('click', () => applyValues(presets[button.dataset.preset])));
  byId('exportCsv').addEventListener('click', exportCsv);
  byId('exportSvg').addEventListener('click', exportSvg);
  ['toggleIsotherms', 'toggleIsentropes', 'toggleQuality'].forEach(id => byId(id).addEventListener('change', async event => {
    const family = id === 'toggleIsotherms' ? 'isotherms' : id === 'toggleIsentropes' ? 'isentropes' : 'quality';
    renderChart();
    if (event.target.checked) await ensureDiagramFamily(family);
    setRuntime('CoolProp WASM · gereed', 'ready', 100);
  }));
}

async function initialize() {
  renderControls();
  bindUi();
  renderChart();

  // Register early; after the first successful runtime load the worker receives a cache hint.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(error => console.info('Service worker niet actief:', error));
  }

  await nextFrame();
  setRuntime('CoolProp-module laden…', 'loading', 18);

  try {
    CP = await CoolPropFactory({
      locateFile: path => path.endsWith('.wasm') ? new URL('./coolprop.wasm', import.meta.url).href : path,
      printErr: message => console.warn('[CoolProp]', message)
    });
    if (typeof CP.PropsSI !== 'function') throw new Error('Deze CoolProp-build exporteert PropsSI niet via Embind.');

    setRuntime('CoolProp gereed · cyclus berekenen…', 'loading', 66);
    await nextFrame();
    runCycle();
    setRuntime('Cyclus gereed · diagramachtergrond laden…', 'ready', 76);

    // Cycle results are shown before any expensive background line generation.
    await idle();
    await ensureDiagramFamily('dome');
    if (byId('toggleIsotherms').checked) await ensureDiagramFamily('isotherms');
    if (byId('toggleIsentropes').checked) await ensureDiagramFamily('isentropes');
    if (byId('toggleQuality').checked) await ensureDiagramFamily('quality');
    setRuntime('CoolProp WASM · gereed', 'ready', 100);
    navigator.serviceWorker?.ready.then(registration => registration.active?.postMessage({ type: 'CACHE_WASM' })).catch(() => {});
  } catch (error) {
    console.error(error);
    const missing = /wasm|fetch|404|instantiate/i.test(String(error));
    showMessage(missing
      ? 'CoolProp kon niet starten. Controleer of coolprop.wasm naast index.html staat en bij deze coolprop.js-versie hoort.'
      : `CoolProp kon niet starten: ${error.message || error}`);
    setRuntime('CoolProp WASM · fout', 'error', 100);
    byId('chartEmpty').querySelector('strong').textContent = 'CoolProp niet beschikbaar';
    byId('chartEmpty').querySelector('small').textContent = 'Controleer coolprop.wasm en vernieuw daarna de pagina.';
  }

}

initialize();
