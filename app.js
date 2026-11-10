import CoolPropFactory from './coolprop.js';

const FLUID = 'HEOS::CO2';
const BAR = 1e5;
const K0 = 273.15;
const SVG_NS = 'http://www.w3.org/2000/svg';
const CRIT_DEFAULT = { T: 304.1282, P: 7.3773e6 };

const DEFAULTS = {
  evapTemp: -30,
  receiverPressure: 35,
  highPressure: 90,
  gasCoolerTemp: 32,
  superheat: 8,
  intercoolerApproach: 5,
  etaLow: 70,
  etaHigh: 70,
  capacity: 30
};

const PRESETS = {
  freeze: { ...DEFAULTS },
  medium: { ...DEFAULTS, evapTemp: -10, receiverPressure: 45, highPressure: 92, gasCoolerTemp: 34, superheat: 6, capacity: 50 },
  hot: { ...DEFAULTS, evapTemp: -25, receiverPressure: 40, highPressure: 105, gasCoolerTemp: 40, superheat: 10, capacity: 60 }
};

const CONTROL_META = {
  evapTemp: { suffix: ' °C', digits: 0 },
  receiverPressure: { suffix: ' bar', digits: 0 },
  highPressure: { suffix: ' bar', digits: 0 },
  gasCoolerTemp: { suffix: ' °C', digits: 0 },
  superheat: { suffix: ' K', digits: 0 },
  intercoolerApproach: { suffix: ' K', digits: 0 },
  etaLow: { suffix: ' %', digits: 0 },
  etaHigh: { suffix: ' %', digits: 0 },
  capacity: { suffix: ' kW', digits: 0 }
};

let CP;
let critical = { ...CRIT_DEFAULT };
let currentResult = null;
let isoData = { dome: null, temperatures: [], entropies: [], qualities: [] };
let recalculationTimer;

const $ = id => document.getElementById(id);
const els = {
  status: $('runtimeStatus'), statusDot: $('statusDot'), message: $('message'),
  chart: $('phChart'), tooltip: $('tooltip'), loader: $('chartLoader'),
  rows: $('stateRows'), checks: $('checks')
};

const fmt = (value, digits = 1) => Number.isFinite(value)
  ? new Intl.NumberFormat('nl-BE', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
  : '—';

function setStatus(text, type = 'loading') {
  els.status.textContent = text;
  els.statusDot.className = `status-dot ${type === 'loading' ? '' : type}`;
}

function showMessage(text) {
  els.message.textContent = text;
  els.message.classList.remove('hidden');
}

function clearMessage() {
  els.message.classList.add('hidden');
  els.message.textContent = '';
}

function readInputs() {
  return Object.fromEntries(Object.keys(DEFAULTS).map(id => [id, Number($(id).value)]));
}

function updateOutputs() {
  for (const [id, meta] of Object.entries(CONTROL_META)) {
    const value = Number($(id).value);
    $(`${id}Out`).textContent = `${fmt(value, meta.digits)}${meta.suffix}`;
  }
}

function props(output, name1, value1, name2, value2) {
  const value = Number(CP.PropsSI(output, name1, value1, name2, value2, FLUID));
  if (!Number.isFinite(value) || Math.abs(value) > 1e50) {
    throw new Error(`CoolProp gaf geen geldige waarde voor ${output}(${name1}, ${name2}).`);
  }
  return value;
}

function tryProps(...args) {
  try { return props(...args); } catch { return NaN; }
}

function statePH(n, label, p, h, forcedPhase = '') {
  const T = props('T', 'P', p, 'H', h);
  const s = props('S', 'P', p, 'H', h);
  const rho = tryProps('D', 'P', p, 'H', h);
  return { n, label, p, T, h, s, rho, phase: forcedPhase || phaseFromPH(p, h) };
}

function statePT(n, label, p, T, forcedPhase = '') {
  const h = props('H', 'P', p, 'T', T);
  const s = props('S', 'P', p, 'T', T);
  const rho = tryProps('D', 'P', p, 'T', T);
  return { n, label, p, T, h, s, rho, phase: forcedPhase || phaseFromPH(p, h) };
}

function statePQ(n, label, p, q, forcedPhase = '') {
  const h = props('H', 'P', p, 'Q', q);
  const T = props('T', 'P', p, 'Q', q);
  const s = props('S', 'P', p, 'Q', q);
  const rho = tryProps('D', 'P', p, 'Q', q);
  return { n, label, p, T, h, s, rho, q, phase: forcedPhase || (q === 0 ? 'verzadigde vloeistof' : 'verzadigde damp') };
}

function phaseFromPH(p, h) {
  if (p >= critical.P * .999) return 'superkritisch / éénfasig';
  const hL = tryProps('H', 'P', p, 'Q', 0);
  const hV = tryProps('H', 'P', p, 'Q', 1);
  if (!Number.isFinite(hL) || !Number.isFinite(hV)) return 'éénfasig';
  if (h < hL - 300) return 'onderkoelde vloeistof';
  if (h > hV + 300) return 'oververhitte damp';
  if (h <= hL + 300) return 'verzadigde vloeistof';
  if (h >= hV - 300) return 'verzadigde damp';
  const q = (h - hL) / (hV - hL);
  return `tweefasig (x=${fmt(q, 2)})`;
}

function validateInputs(v, pEvap) {
  const pI = v.receiverPressure * BAR;
  const pH = v.highPressure * BAR;
  if (pI >= critical.P * .985) throw new Error('De receiverdruk moet onder de kritische druk van CO₂ blijven (73,8 bar).');
  if (pI <= pEvap * 1.04) throw new Error('De receiverdruk moet duidelijk hoger zijn dan de verdampingsdruk.');
  if (pH <= pI * 1.04) throw new Error('De hogedruk moet hoger zijn dan de receiverdruk.');
  if (v.etaLow <= 0 || v.etaHigh <= 0) throw new Error('De isentropische rendementen moeten groter dan nul zijn.');
}

function calculateCycle(v) {
  const pEvap = props('P', 'T', v.evapTemp + K0, 'Q', 1);
  validateInputs(v, pEvap);
  const pInt = v.receiverPressure * BAR;
  const pHigh = v.highPressure * BAR;
  const etaL = v.etaLow / 100;
  const etaH = v.etaHigh / 100;
  const tReceiver = props('T', 'P', pInt, 'Q', 0);

  const s1 = statePT(1, 'Verdamper uit / LP-zuig', pEvap, v.evapTemp + v.superheat + K0, 'oververhitte damp');
  const h2s = props('H', 'P', pInt, 'S', s1.s);
  const h2 = s1.h + (h2s - s1.h) / etaL;
  const s2 = statePH(2, 'LP-compressor uit', pInt, h2, 'oververhitte damp');

  const t3Target = tReceiver + v.intercoolerApproach;
  const s3 = statePT(3, 'Intercooler uit', pInt, t3Target, 'oververhitte damp');
  if (s3.h >= s2.h) throw new Error('De gekozen intercooleruitlaat is warmer dan de persgastemperatuur van de lage trap. Verhoog de drukverhouding of verlaag de intercooler-benadering.');

  const s4 = statePQ(4, 'Flashgas uit receiver', pInt, 1, 'verzadigde damp');
  const s7 = statePT(7, 'Gaskoeler uit', pHigh, v.gasCoolerTemp + K0, 'éénfasig hogedruk');
  const h9 = props('H', 'P', pInt, 'Q', 0);
  const h4 = s4.h;
  const flashFraction = (s7.h - h9) / (h4 - h9);
  if (!(flashFraction > 0 && flashFraction < .92)) {
    throw new Error(`De expansie naar de receiver levert geen bruikbare tweefasenstroming (berekend flashaandeel ${fmt(flashFraction * 100, 1)}%). Pas hogedruk, gaskoeleruitlaat of receiverdruk aan.`);
  }

  const highPerLow = 1 / (1 - flashFraction);
  const flashPerLow = highPerLow - 1;
  const h5 = (s3.h + flashPerLow * s4.h) / highPerLow;
  const s5 = statePH(5, 'HP-zuig na menging', pInt, h5);

  const h6s = props('H', 'P', pHigh, 'S', s5.s);
  const h6 = s5.h + (h6s - s5.h) / etaH;
  const s6 = statePH(6, 'HP-compressor uit', pHigh, h6, 'superkritisch persgas');
  const s8 = statePH(8, 'Na hogedrukklep / receiver in', pInt, s7.h, `tweefasig (x=${fmt(flashFraction, 2)})`);
  const s9 = statePQ(9, 'Vloeistof uit receiver', pInt, 0, 'verzadigde vloeistof');
  const s10 = statePH(10, 'Na vloeistofventiel / verdamper in', pEvap, s9.h);

  const qEvap = s1.h - s10.h;
  if (qEvap <= 0) throw new Error('Het specifieke koelvermogen is niet positief. Controleer de druk- en temperatuurinstellingen.');
  const mLow = v.capacity * 1000 / qEvap;
  const mHigh = mLow * highPerLow;
  const mFlash = mHigh - mLow;
  const wLow = mLow * (s2.h - s1.h) / 1000;
  const wHigh = mHigh * (s6.h - s5.h) / 1000;
  const qIntercooler = mLow * (s2.h - s3.h) / 1000;
  const qGasCooler = mHigh * (s6.h - s7.h) / 1000;
  const power = wLow + wHigh;
  const cop = v.capacity / power;
  const balanceResidual = v.capacity + power - qIntercooler - qGasCooler;
  const balancePct = 100 * balanceResidual / Math.max(qGasCooler, 1e-9);

  const states = [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10].sort((a, b) => a.n - b.n);
  return {
    inputs: v, states, by: Object.fromEntries(states.map(s => [s.n, s])),
    pEvap, pInt, pHigh, tReceiver, flashFraction, mLow, mHigh, mFlash,
    wLow, wHigh, power, qIntercooler, qGasCooler, cop, balanceResidual, balancePct,
    ratioLow: pInt / pEvap, ratioHigh: pHigh / pInt,
    pIntIdeal: Math.sqrt(pEvap * pHigh)
  };
}

function renderMetrics(r) {
  $('copValue').textContent = fmt(r.cop, 2);
  $('powerValue').textContent = `${fmt(r.power, 1)} kW`;
  $('powerSplit').textContent = `${fmt(r.wLow, 1)} + ${fmt(r.wHigh, 1)} kW`;
  $('massLowValue').textContent = `${fmt(r.mLow, 3)} kg/s`;
  $('flashValue').textContent = `${fmt(r.flashFraction * 100, 1)} %`;
  $('intercoolerValue').textContent = `${fmt(r.qIntercooler, 1)} kW`;
  $('gasCoolerValue').textContent = `${fmt(r.qGasCooler, 1)} kW`;
  $('receiverTemp').textContent = `${fmt(r.tReceiver - K0, 1)} °C`;
  $('massHighValue').textContent = `${fmt(r.mHigh, 3)} kg/s`;
  $('energyBalance').textContent = `${fmt(r.balancePct, 2)} %`;
}

function renderTable(r) {
  els.rows.innerHTML = r.states.map(s => `
    <tr>
      <td><span class="point-chip">${s.n}</span></td>
      <td>${s.label}</td>
      <td>${fmt(s.p / BAR, 2)}</td>
      <td>${fmt(s.T - K0, 2)}</td>
      <td>${fmt(s.h / 1000, 2)}</td>
      <td>${fmt(s.s / 1000, 3)}</td>
      <td>${fmt(s.rho, 2)}</td>
      <td class="phase">${s.phase}</td>
    </tr>`).join('');
}

function renderChecks(r) {
  const transcritical = r.pHigh > critical.P;
  const flashOk = r.flashFraction >= .08 && r.flashFraction <= .55;
  const ratioSpread = Math.abs(r.ratioLow - r.ratioHigh) / ((r.ratioLow + r.ratioHigh) / 2);
  const ratiosOk = ratioSpread < .35;
  const maxDischarge = Math.max(r.by[2].T, r.by[6].T) - K0;
  const tempOk = maxDischarge < 150;
  const intDeviation = 100 * (r.pInt - r.pIntIdeal) / r.pIntIdeal;
  const checks = [
    [transcritical, 'Hogedrukgebied', transcritical ? `De hogedruk ligt boven pcrit (${fmt(critical.P / BAR, 1)} bar).` : 'De cyclus is niet transkritisch; verhoog de hogedruk.'],
    [flashOk, 'Flashgasaandeel', `${fmt(r.flashFraction * 100, 1)}% van het hogedrukdebiet flasht in de receiver.`],
    [ratiosOk, 'Drukverhoudingen', `LP ${fmt(r.ratioLow, 2)} · HP ${fmt(r.ratioHigh, 2)}. Geometrische richtdruk: ${fmt(r.pIntIdeal / BAR, 1)} bar (${intDeviation >= 0 ? '+' : ''}${fmt(intDeviation, 0)}%).`],
    [tempOk, 'Persgastemperatuur', `Hoogste berekende persgastemperatuur: ${fmt(maxDischarge, 1)} °C.`],
    [Math.abs(r.balancePct) < .15, 'Energiebalans', `Residueel verschil: ${fmt(r.balanceResidual, 3)} kW (${fmt(r.balancePct, 3)}%).`]
  ];
  els.checks.innerHTML = checks.map(([ok, title, detail]) => `
    <div class="check ${ok ? '' : 'warn'}"><i>${ok ? '✓' : '!'}</i><div><strong>${title}</strong><span>${detail}</span></div></div>`).join('');
}

function svgEl(name, attrs = {}, text = '') {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text) el.textContent = text;
  return el;
}

function logSpace(start, end, count) {
  const a = Math.log(start), b = Math.log(end);
  return Array.from({ length: count }, (_, i) => Math.exp(a + (b - a) * i / (count - 1)));
}

function splitValid(points, jump = 170) {
  const segments = [];
  let current = [];
  for (const point of points) {
    if (!point || !Number.isFinite(point.h) || !Number.isFinite(point.p) || point.h < -150 || point.h > 1000) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    if (current.length && Math.abs(point.h - current.at(-1).h) > jump) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);
  return segments;
}

const tick = () => new Promise(resolve => requestAnimationFrame(resolve));

async function generateIsolines() {
  els.loader.classList.remove('hidden');
  const Tmin = 217.0;
  const Tmax = critical.T - .12;
  const domeL = [], domeV = [];
  for (let i = 0; i < 72; i++) {
    const f = i / 71;
    const T = Tmin + (Tmax - Tmin) * (1 - Math.cos(Math.PI * f)) / 2;
    const p = tryProps('P', 'T', T, 'Q', 0);
    const hL = tryProps('H', 'T', T, 'Q', 0) / 1000;
    const hV = tryProps('H', 'T', T, 'Q', 1) / 1000;
    if ([p, hL, hV].every(Number.isFinite)) { domeL.push({ h: hL, p }); domeV.push({ h: hV, p }); }
  }
  const criticalHExact = tryProps('H', 'T', critical.T, 'P', critical.P) / 1000;
  const criticalHFallback = domeL.length && domeV.length ? (domeL.at(-1).h + domeV.at(-1).h) / 2 : NaN;
  isoData.dome = { liquid: domeL, vapor: domeV, critical: { h: Number.isFinite(criticalHExact) ? criticalHExact : criticalHFallback, p: critical.P } };
  await tick();

  const temperatureValues = [-50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 60, 80, 100, 120, 140, 160];
  isoData.temperatures = [];
  for (const tc of temperatureValues) {
    const T = tc + K0;
    const raw = logSpace(5 * BAR, 140 * BAR, 46).map(p => ({ p, h: tryProps('H', 'P', p, 'T', T) / 1000 }));
    const segments = splitValid(raw);
    if (T < critical.T) {
      const ps = tryProps('P', 'T', T, 'Q', 0);
      const hL = tryProps('H', 'T', T, 'Q', 0) / 1000;
      const hV = tryProps('H', 'T', T, 'Q', 1) / 1000;
      if ([ps, hL, hV].every(Number.isFinite) && ps >= 5 * BAR) segments.push([{ h: hL, p: ps }, { h: hV, p: ps }]);
    }
    isoData.temperatures.push({ value: tc, segments });
    await tick();
  }

  const entropyValues = [1.2, 1.4, 1.6, 1.8, 2.0, 2.2, 2.4, 2.6];
  isoData.entropies = [];
  for (const sk of entropyValues) {
    const raw = logSpace(5 * BAR, 140 * BAR, 52).map(p => ({ p, h: tryProps('H', 'P', p, 'S', sk * 1000) / 1000 }));
    isoData.entropies.push({ value: sk, segments: splitValid(raw, 120) });
    await tick();
  }

  isoData.qualities = [];
  for (const q of [.1, .3, .5, .7, .9]) {
    const points = [];
    for (let i = 0; i < 48; i++) {
      const T = Tmin + (Tmax - Tmin) * i / 47;
      const p = tryProps('P', 'T', T, 'Q', q);
      const h = tryProps('H', 'T', T, 'Q', q) / 1000;
      if ([p, h].every(Number.isFinite)) points.push({ p, h });
    }
    isoData.qualities.push({ value: q, segments: [points] });
    await tick();
  }
  els.loader.classList.add('hidden');
}

function renderChart(r) {
  const svg = els.chart;
  svg.replaceChildren();
  const W = 1040, H = 650;
  const margin = { l: 82, r: 27, t: 28, b: 66 };
  const plotW = W - margin.l - margin.r;
  const plotH = H - margin.t - margin.b;
  const xMin = 50, xMax = 700, pMin = 5, pMax = 140;
  const x = h => margin.l + (h - xMin) / (xMax - xMin) * plotW;
  const y = pPa => margin.t + (Math.log(pMax) - Math.log(pPa / BAR)) / (Math.log(pMax) - Math.log(pMin)) * plotH;
  const inPlot = pt => pt.h >= xMin && pt.h <= xMax && pt.p / BAR >= pMin && pt.p / BAR <= pMax;
  const pathD = points => points.filter(inPlot).map((pt, i) => `${i ? 'L' : 'M'}${x(pt.h).toFixed(1)},${y(pt.p).toFixed(1)}`).join(' ');

  const defs = svgEl('defs');
  const clip = svgEl('clipPath', { id: 'plotClip' });
  clip.append(svgEl('rect', { x: margin.l, y: margin.t, width: plotW, height: plotH }));
  defs.append(clip);
  const marker = svgEl('marker', { id: 'cycleArrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' });
  marker.append(svgEl('path', { d: 'M0,0 L0,6 L8,3 z', fill: '#34d4ff' }));
  defs.append(marker);
  svg.append(defs, svgEl('rect', { class: 'chart-bg', width: W, height: H }));

  const grid = svgEl('g');
  for (let h = 50; h <= 700; h += 50) {
    grid.append(svgEl('line', { class: `grid-line ${h % 100 ? 'minor' : ''}`, x1: x(h), x2: x(h), y1: margin.t, y2: H - margin.b }));
    grid.append(svgEl('text', { class: 'axis-text', x: x(h), y: H - margin.b + 25, 'text-anchor': 'middle' }, String(h)));
  }
  const pTicks = [5, 7.5, 10, 15, 20, 30, 40, 50, 70, 100, 140];
  pTicks.forEach(p => {
    grid.append(svgEl('line', { class: `grid-line ${[5,10,20,40,100,140].includes(p) ? '' : 'minor'}`, x1: margin.l, x2: W - margin.r, y1: y(p * BAR), y2: y(p * BAR) }));
    grid.append(svgEl('text', { class: 'axis-text', x: margin.l - 13, y: y(p * BAR) + 4, 'text-anchor': 'end' }, String(p).replace('.', ',')));
  });
  grid.append(svgEl('line', { class: 'axis-line', x1: margin.l, x2: margin.l, y1: margin.t, y2: H - margin.b }));
  grid.append(svgEl('line', { class: 'axis-line', x1: margin.l, x2: W - margin.r, y1: H - margin.b, y2: H - margin.b }));
  grid.append(svgEl('text', { class: 'axis-title', x: margin.l + plotW / 2, y: H - 18, 'text-anchor': 'middle' }, 'Specifieke enthalpie h (kJ/kg)'));
  grid.append(svgEl('text', { class: 'axis-title', x: 22, y: margin.t + plotH / 2, transform: `rotate(-90 22 ${margin.t + plotH / 2})`, 'text-anchor': 'middle' }, 'Absolute druk p (bar) · log-schaal'));
  svg.append(grid);

  const layers = svgEl('g', { 'clip-path': 'url(#plotClip)' });
  if (isoData.dome) {
    const domePolygon = [...isoData.dome.liquid, ...[...isoData.dome.vapor].reverse()];
    layers.append(svgEl('path', { class: 'dome-fill', d: `${pathD(domePolygon)} Z` }));
  }

  const drawIsolines = (data, className, labelClass, show, labelEvery = 1, formatter = String) => {
    if (!show) return;
    data.forEach((curve, index) => {
      curve.segments.forEach(segment => {
        const d = pathD(segment);
        if (d.includes('L')) layers.append(svgEl('path', { class: className, d }));
      });
      if (index % labelEvery === 0) {
        const candidates = curve.segments.flat().filter(inPlot);
        const pt = candidates[Math.floor(candidates.length * .72)];
        if (pt) layers.append(svgEl('text', { class: `iso-label ${labelClass}`, x: x(pt.h) + 3, y: y(pt.p) - 3 }, formatter(curve.value)));
      }
    });
  };
  drawIsolines(isoData.temperatures, 'isoline-temp', 'temp', $('showTemperature').checked, 2, v => `${v}°C`);
  drawIsolines(isoData.entropies, 'isoline-entropy', 'entropy', $('showEntropy').checked, 1, v => `s=${String(v).replace('.', ',')}`);
  drawIsolines(isoData.qualities, 'isoline-quality', 'quality', $('showQuality').checked, 1, v => `x=${String(v).replace('.', ',')}`);

  if (isoData.dome) {
    ['liquid', 'vapor'].forEach(side => layers.append(svgEl('path', { class: 'dome-line', d: pathD(isoData.dome[side]) })));
    const cp = isoData.dome.critical;
    if (cp && inPlot(cp)) layers.append(svgEl('circle', { class: 'critical', cx: x(cp.h), cy: y(cp.p), r: 5 }));
  }

  const point = n => ({ h: r.by[n].h / 1000, p: r.by[n].p });
  const mainSegments = [[1,2],[2,3],[3,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,1]];
  mainSegments.forEach(([a,b]) => layers.append(svgEl('path', { class: 'cycle-main', d: pathD([point(a), point(b)]) })));
  layers.append(svgEl('path', { class: 'cycle-branch', d: pathD([point(8), point(4), point(5)]) }));

  r.states.forEach(state => {
    const pt = point(state.n);
    if (!inPlot(pt)) return;
    const g = svgEl('g', { 'data-state': state.n });
    g.append(svgEl('circle', { class: 'state-point', cx: x(pt.h), cy: y(pt.p), r: 5.5 }));
    const lx = x(pt.h) + (state.n === 8 ? 13 : -13);
    const ly = y(pt.p) + (state.n === 7 ? -14 : state.n === 4 ? -16 : 15);
    g.append(svgEl('circle', { class: 'state-label-bg', cx: lx, cy: ly, r: 10 }));
    g.append(svgEl('text', { class: 'state-label', x: lx, y: ly + .5 }, String(state.n)));
    g.addEventListener('mouseenter', event => showTooltip(event, state));
    g.addEventListener('mousemove', event => moveTooltip(event));
    g.addEventListener('mouseleave', hideTooltip);
    layers.append(g);
  });
  svg.append(layers);
}

function showTooltip(event, state) {
  els.tooltip.innerHTML = `<b>Punt ${state.n} · ${state.label}</b><br>${fmt(state.p / BAR, 2)} bar · ${fmt(state.T - K0, 2)} °C<br>${fmt(state.h / 1000, 2)} kJ/kg · ${fmt(state.s / 1000, 3)} kJ/kg·K`;
  els.tooltip.classList.remove('hidden');
  moveTooltip(event);
}
function moveTooltip(event) {
  const wrap = els.chart.parentElement.getBoundingClientRect();
  els.tooltip.style.left = `${Math.min(event.clientX - wrap.left + 12, wrap.width - 230)}px`;
  els.tooltip.style.top = `${Math.max(event.clientY - wrap.top - 68, 8)}px`;
}
function hideTooltip() { els.tooltip.classList.add('hidden'); }

function renderAll(result) {
  renderMetrics(result);
  renderTable(result);
  renderChecks(result);
  renderChart(result);
}

function recalculate() {
  updateOutputs();
  if (!CP) return;
  try {
    clearMessage();
    currentResult = calculateCycle(readInputs());
    renderAll(currentResult);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function scheduleRecalculation() {
  clearTimeout(recalculationTimer);
  recalculationTimer = setTimeout(recalculate, 110);
}

function applyPreset(name) {
  const preset = PRESETS[name];
  for (const [id, value] of Object.entries(preset)) $(id).value = value;
  document.querySelectorAll('.preset').forEach(button => button.classList.toggle('active', button.dataset.preset === name));
  recalculate();
}

function downloadBlob(name, type, content) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv() {
  if (!currentResult) return;
  const header = ['Punt','Locatie','p_bar_abs','T_C','h_kJ_kg','s_kJ_kgK','rho_kg_m3','Fase'];
  const rows = currentResult.states.map(s => [s.n, s.label, s.p/BAR, s.T-K0, s.h/1000, s.s/1000, s.rho, s.phase]);
  const csv = [header, ...rows].map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(';')).join('\r\n');
  downloadBlob('r744-tweetraps-toestandspunten.csv', 'text/csv;charset=utf-8', `\ufeff${csv}`);
}

function downloadSvg() {
  const clone = els.chart.cloneNode(true);
  clone.setAttribute('xmlns', SVG_NS);
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = `.chart-bg{fill:#061625}.grid-line{stroke:#15334b;stroke-width:1}.grid-line.minor{opacity:.48}.axis-line{stroke:#68839a;stroke-width:1.2}.axis-text{fill:#8aa6bc;font:12px sans-serif}.axis-title{fill:#d9e7f2;font:bold 13px sans-serif}.dome-fill{fill:rgba(73,223,164,.045)}.dome-line{fill:none;stroke:#d4e0e9;stroke-width:2.2}.critical{fill:#ff6780;stroke:#fff;stroke-width:1.5}.isoline-temp{fill:none;stroke:#ffad49;stroke-width:1;opacity:.43}.isoline-entropy{fill:none;stroke:#b18cff;stroke-width:1;opacity:.38;stroke-dasharray:6 5}.isoline-quality{fill:none;stroke:#49dfa4;stroke-width:1;opacity:.45;stroke-dasharray:2 4}.iso-label{font:10px sans-serif;paint-order:stroke;stroke:#061625;stroke-width:3px}.iso-label.temp{fill:#ffad49}.iso-label.entropy{fill:#b18cff}.iso-label.quality{fill:#49dfa4}.cycle-main{fill:none;stroke:#34d4ff;stroke-width:3.2}.cycle-branch{fill:none;stroke:#8bb3cf;stroke-width:2.1;stroke-dasharray:7 6}.state-point{fill:#34d4ff;stroke:#eafdff;stroke-width:2}.state-label-bg{fill:#dff8ff}.state-label{fill:#062035;font:bold 11px sans-serif;text-anchor:middle;dominant-baseline:middle}`;
  clone.insertBefore(style, clone.firstChild);
  downloadBlob('r744-tweetraps-logph.svg', 'image/svg+xml;charset=utf-8', new XMLSerializer().serializeToString(clone));
}

function bindEvents() {
  Object.keys(DEFAULTS).forEach(id => $(id).addEventListener('input', scheduleRecalculation));
  document.querySelectorAll('.preset').forEach(button => button.addEventListener('click', () => applyPreset(button.dataset.preset)));
  $('resetButton').addEventListener('click', () => applyPreset('freeze'));
  ['showTemperature','showEntropy','showQuality'].forEach(id => $(id).addEventListener('change', () => currentResult && renderChart(currentResult)));
  $('downloadCsv').addEventListener('click', downloadCsv);
  $('downloadSvg').addEventListener('click', downloadSvg);
}

async function initialize() {
  bindEvents();
  updateOutputs();
  try {
    setStatus('CoolProp WASM laden…');
    CP = await CoolPropFactory({
      locateFile: path => path.endsWith('.wasm') ? new URL('./coolprop.wasm', import.meta.url).href : path
    });
    if (typeof CP.PropsSI !== 'function') {
      const publicExports = Object.keys(CP).filter(key => !key.startsWith('_')).slice(0, 30).join(', ');
      throw new Error(`PropsSI is niet beschikbaar in deze CoolProp-build. Beschikbare exports: ${publicExports || 'geen'}`);
    }
    critical.T = tryProps('Tcrit', '', 0, '', 0) || CRIT_DEFAULT.T;
    critical.P = tryProps('Pcrit', '', 0, '', 0) || CRIT_DEFAULT.P;
    const test = props('H', 'T', 300, 'P', 1e6);
    if (!Number.isFinite(test)) throw new Error('CoolProp-testberekening mislukt.');
    setStatus('CoolProp WASM · gereed', 'ready');
    currentResult = calculateCycle(readInputs());
    renderAll(currentResult);
    await generateIsolines();
    renderChart(currentResult);
  } catch (error) {
    console.error(error);
    setStatus('CoolProp WASM · fout', 'error');
    els.loader.classList.add('hidden');
    showMessage(`CoolProp kon niet worden gestart: ${error.message || error}. Controleer of coolprop.js en coolprop.wasm naast index.html staan en via GitHub Pages worden geladen.`);
    els.rows.innerHTML = '<tr><td colspan="8">Geen berekening beschikbaar.</td></tr>';
  }
}

initialize();
