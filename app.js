import CoolPropFactory from './coolprop.js';

const FLUID = 'CO2';
const CP_WATER = 4.18; // kJ/(kg.K)
const DIAGRAM_CACHE_KEY = 'r744-diagram-v3-cp8';
const $ = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
let CP = null;
let currentCycle = null;
let baseDiagram = null;
let optionalDiagram = { quality: null, isentropes: null };
let calculationTimer = 0;
let diagramJob = 0;

const controlSpec = {
  evapTemp: { digits: 0, unit: '°C' },
  receiverPressure: { digits: 0, unit: 'bar' },
  highPressure: { digits: 0, unit: 'bar' },
  gasCoolerTemp: { digits: 0, unit: '°C' },
  superheat: { digits: 0, unit: 'K' },
  intercoolerApproach: { digits: 0, unit: 'K' },
  etaLow: { digits: 0, unit: '%' },
  etaHigh: { digits: 0, unit: '%' },
  coolingCapacity: { digits: 0, unit: 'kW' },
  waterInTemp: { digits: 0, unit: '°C' },
  waterTargetTemp: { digits: 0, unit: '°C' },
  waterMassFlow: { digits: 3, unit: 'kg/s' },
  pinch: { digits: 0, unit: 'K' }
};

const presets = {
  freeze: { evapTemp: -35, receiverPressure: 34, highPressure: 92, gasCoolerTemp: 35, superheat: 8, intercoolerApproach: 5, etaLow: 68, etaHigh: 72, coolingCapacity: 30 },
  medium: { evapTemp: -10, receiverPressure: 40, highPressure: 88, gasCoolerTemp: 33, superheat: 6, intercoolerApproach: 4, etaLow: 74, etaHigh: 75, coolingCapacity: 50 },
  summer: { evapTemp: -30, receiverPressure: 38, highPressure: 105, gasCoolerTemp: 43, superheat: 8, intercoolerApproach: 6, etaLow: 68, etaHigh: 70, coolingCapacity: 30 }
};

const defaults = Object.fromEntries(Object.keys(controlSpec).map(id => [id, Number($(id).value)]));
defaults.heatRecoveryEnabled = true;

function nl(value, digits = 1) {
  return Number.isFinite(value) ? value.toLocaleString('nl-BE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function cToK(t) { return t + 273.15; }
function pa(bar) { return bar * 1e5; }
function bar(p) { return p / 1e5; }
function kj(h) { return h / 1000; }
function nextFrame() { return new Promise(resolve => setTimeout(resolve, 0)); }
function escapeXml(s) { return String(s).replace(/[<>&'"]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;' }[c])); }

function setStatus(kind, text) {
  const el = $('statusBadge');
  el.className = `status ${kind}`;
  el.innerHTML = `<span></span>${escapeXml(text)}`;
}

function updateControlOutputs() {
  for (const [id, spec] of Object.entries(controlSpec)) {
    const value = Number($(id).value);
    $(id + 'Out').textContent = `${nl(value, spec.digits)} ${spec.unit}`;
  }
  const enabled = $('heatRecoveryEnabled').checked;
  $('heatRecoveryPanel').classList.toggle('active', enabled);
  $('pheComponent').classList.toggle('hidden', !enabled);
  $('phePipeIn').classList.toggle('hidden', !enabled);
  $('phePipeOut').classList.toggle('hidden', !enabled);
  $('waterLoop').classList.toggle('hidden', !enabled);
  $('statePoint6a').classList.toggle('hidden', !enabled);
  $('heatRecoveryBypass').classList.toggle('hidden', enabled);
  $('gasCoolerStateLabel').textContent = enabled ? '6a → 7' : '6 → 7';
}

function inputs() {
  const result = Object.fromEntries(Object.keys(controlSpec).map(id => [id, Number($(id).value)]));
  result.heatRecoveryEnabled = $('heatRecoveryEnabled').checked;
  result.showIsotherms = $('showIsotherms').checked;
  result.showIsentropes = $('showIsentropes').checked;
  result.showQuality = $('showQuality').checked;
  return result;
}

function ps(output, key1, value1, key2, value2) {
  const value = CP.PropsSI(output, key1, value1, key2, value2, FLUID);
  if (!Number.isFinite(value)) throw new Error(`CoolProp gaf geen geldige waarde voor ${output}(${key1}, ${key2}).`);
  return value;
}

function tryPs(output, key1, value1, key2, value2) {
  try { return ps(output, key1, value1, key2, value2); } catch { return NaN; }
}

function statePT(id, label, p, t, massFlow = NaN) {
  return { id, label, p, t, h: ps('Hmass', 'P', p, 'T', t), s: ps('Smass', 'P', p, 'T', t), massFlow };
}
function statePH(id, label, p, h, massFlow = NaN) {
  return { id, label, p, h, t: ps('T', 'P', p, 'Hmass', h), s: ps('Smass', 'P', p, 'Hmass', h), massFlow };
}
function statePQ(id, label, p, q, massFlow = NaN) {
  return { id, label, p, t: ps('T', 'P', p, 'Q', q), h: ps('Hmass', 'P', p, 'Q', q), s: ps('Smass', 'P', p, 'Q', q), massFlow, q };
}

function calculateCycle(v) {
  const warnings = [];
  const pe = ps('P', 'T', cToK(v.evapTemp), 'Q', 1);
  const pi = pa(v.receiverPressure);
  const ph = pa(v.highPressure);
  const pcrit = ps('Pcrit', '', 0, '', 0);
  if (!(pe < pi && pi < ph)) throw new Error(`Drukvolgorde ongeldig: p₀ (${nl(bar(pe), 1)} bar) < pᵢ (${nl(v.receiverPressure, 1)} bar) < pₕ (${nl(v.highPressure, 1)} bar) is vereist.`);
  if (ph <= pcrit) warnings.push('De ingestelde hogedruk ligt niet boven de kritische druk; dit is geen transkritisch hogedruktraject.');

  const s1 = statePT('1', 'Verdamper uit / LP-aanzuig', pe, cToK(v.evapTemp + v.superheat));
  const h2s = ps('Hmass', 'P', pi, 'Smass', s1.s);
  const h2 = s1.h + (h2s - s1.h) / (v.etaLow / 100);
  const s2 = statePH('2', 'LP-compressor uit', pi, h2);

  const satV = statePQ('4', 'Receiver: verzadigde damp', pi, 1);
  const satL = statePQ('9', 'Receiver: verzadigde vloeistof', pi, 0);
  const targetT3 = satV.t + v.intercoolerApproach;
  const actualT3 = Math.max(satV.t + 0.15, Math.min(s2.t, targetT3));
  const s3 = statePT('3', 'Intercooler uit', pi, actualT3);
  if (s2.t <= targetT3 + 0.2) warnings.push('De LP-persgastemperatuur ligt al op of onder het intercoolerdoel; de intercooler voert vrijwel geen warmte af.');

  const s7 = statePT('7', 'Gaskoeler uit', ph, cToK(v.gasCoolerTemp));
  const h8 = s7.h;
  const xRaw = (h8 - satL.h) / (satV.h - satL.h);
  if (!(xRaw > 0 && xRaw < 1)) throw new Error(`De HP-expansie levert bij ${nl(v.receiverPressure, 0)} bar geen tweefasenmengsel in de receiver (berekend x = ${nl(xRaw, 3)}). Pas hogedruk, gaskoeleruittrede of receiverdruk aan.`);
  const x = clamp(xRaw, 0.0001, 0.9999);
  if (x > 0.55) warnings.push(`Hoge flashgasfractie (${nl(100*x, 1)}%): controleer receiverdruk en gaskoelercondities.`);

  const qEvapSpecific = s1.h - satL.h;
  if (qEvapSpecific <= 0) throw new Error('Het specifiek koelvermogen is niet positief. Controleer verdamping en receiverdruk.');
  const mLow = v.coolingCapacity * 1000 / qEvapSpecific;
  const mHigh = mLow / (1 - x);
  const mFlash = mHigh - mLow;
  [s1, s2, s3, satL].forEach(s => s.massFlow = mLow);
  satV.massFlow = mFlash;

  const h5 = (mLow * s3.h + mFlash * satV.h) / mHigh;
  const s5 = statePH('5', 'Menging / HP-aanzuig', pi, h5, mHigh);
  const h6s = ps('Hmass', 'P', ph, 'Smass', s5.s);
  const h6 = s5.h + (h6s - s5.h) / (v.etaHigh / 100);
  const s6 = statePH('6', 'HP-compressor uit', ph, h6, mHigh);

  let qHeatRecovery = 0;
  let waterOut = v.waterInTemp;
  let heatRecoveryLimit = 'uitgeschakeld';
  if (v.heatRecoveryEnabled) {
    if (v.waterTargetTemp <= v.waterInTemp) throw new Error('Het SWW-uitdoel moet hoger zijn dan de koudwatertemperatuur.');
    const waterHotEndLimit = s6.t - 273.15 - v.pinch;
    const feasibleWaterTarget = Math.max(v.waterInTemp, Math.min(v.waterTargetTemp, waterHotEndLimit));
    const qWaterTarget = v.waterMassFlow * CP_WATER * (feasibleWaterTarget - v.waterInTemp);
    const hotOutletMinT = cToK(v.waterInTemp + v.pinch);
    const hPinch = tryPs('Hmass', 'P', ph, 'T', hotOutletMinT);
    const hMin = Math.max(s7.h, Number.isFinite(hPinch) ? hPinch : s7.h);
    const qHotMax = Math.max(0, mHigh * (s6.h - hMin) / 1000);
    qHeatRecovery = Math.max(0, Math.min(qWaterTarget, qHotMax));
    waterOut = v.waterInTemp + qHeatRecovery / (v.waterMassFlow * CP_WATER);
    heatRecoveryLimit = qWaterTarget <= qHotMax + 0.01 ? 'SWW-doel/debiet' : 'CO₂-zijde/pinch';
    if (feasibleWaterTarget < v.waterTargetTemp - 0.1) warnings.push(`Het SWW-doel is hoger dan de warme-eindlimiet T₆ − ΔTmin; maximaal haalbaar is circa ${nl(feasibleWaterTarget, 1)} °C.`);
    if (waterOut < v.waterTargetTemp - 0.5) warnings.push(`Het gevraagde SWW-doel wordt niet bereikt: berekend ${nl(waterOut, 1)} °C bij ${nl(v.waterMassFlow, 3)} kg/s.`);
  }
  const h6a = s6.h - qHeatRecovery * 1000 / mHigh;
  const s6a = statePH('6a', v.heatRecoveryEnabled ? 'Platen-WW uit' : 'Heat recovery gebypasst', ph, h6a, mHigh);
  s7.massFlow = mHigh;
  const s8 = statePH('8', 'HP-ventiel uit / receiver in', pi, h8, mHigh);
  s8.q = x;
  const s10 = statePH('10', 'LP-ventiel uit / verdamper in', pe, satL.h, mLow);
  s10.q = tryPs('Q', 'P', pe, 'Hmass', satL.h);

  const wLow = mLow * (s2.h - s1.h) / 1000;
  const wHigh = mHigh * (s6.h - s5.h) / 1000;
  const qIntercooler = Math.max(0, mLow * (s2.h - s3.h) / 1000);
  const qGasCooler = Math.max(0, mHigh * (s6a.h - s7.h) / 1000);
  const qEvap = v.coolingCapacity;
  const balanceError = qEvap + wLow + wHigh - qIntercooler - qHeatRecovery - qGasCooler;
  const cop = qEvap / (wLow + wHigh);
  const pressureRatioLow = pi / pe;
  const pressureRatioHigh = ph / pi;
  if (pressureRatioLow > 4 || pressureRatioHigh > 4) warnings.push(`Hoge drukverhouding: LP ${nl(pressureRatioLow, 2)} en HP ${nl(pressureRatioHigh, 2)}.`);
  if (s6.t - 273.15 > 160) warnings.push(`Hoge HP-persgastemperatuur (${nl(s6.t - 273.15, 1)} °C).`);
  if (Math.abs(balanceError) > Math.max(0.1, qEvap * 0.005)) warnings.push(`De numerieke energiebalans wijkt ${nl(balanceError, 2)} kW af.`);

  const states = [s1, s2, s3, satV, s5, s6, ...(v.heatRecoveryEnabled ? [s6a] : []), s7, s8, satL, s10];
  return {
    values: v, states, byId: Object.fromEntries(states.map(s => [s.id, s])), warnings,
    pe, pi, ph, pcrit, x, mLow, mHigh, mFlash, waterOut, heatRecoveryLimit,
    wLow, wHigh, qIntercooler, qHeatRecovery, qGasCooler, qEvap, balanceError, cop,
    receiverTemp: satL.t - 273.15
  };
}

function renderCycle(c) {
  $('copValue').textContent = nl(c.cop, 2);
  $('powerValue').textContent = `${nl(c.wLow + c.wHigh, 1)} kW`;
  $('powerDetail').textContent = `${nl(c.wLow, 1)} + ${nl(c.wHigh, 1)} kW`;
  $('massFlowValue').textContent = `${nl(c.mHigh, 3)} kg/s`;
  $('massFlowDetail').textContent = `${nl(c.mLow, 3)} + ${nl(c.mFlash, 3)} kg/s`;
  $('heatRecoveryValue').textContent = `${nl(c.qHeatRecovery, 1)} kW`;
  $('heatRecoveryDetail').textContent = c.values.heatRecoveryEnabled ? `begrensd door ${c.heatRecoveryLimit}` : 'bypass actief';
  $('waterOutValue').textContent = `${nl(c.waterOut, 1)} °C`;
  $('waterOutDetail').textContent = `doel ${nl(c.values.waterTargetTemp, 0)} °C`;
  $('flashValue').textContent = `${nl(c.x * 100, 1)} %`;
  $('receiverTempValue').textContent = `${nl(c.receiverTemp, 1)} °C`;
  $('lowMassFlowValue').textContent = `${nl(c.mLow, 3)} kg/s`;
  $('flashMassFlowValue').textContent = `${nl(c.mFlash, 3)} kg/s`;
  $('balanceValue').textContent = `${nl(c.balanceError, 3)} kW`;
  $('waterLabelHot').textContent = `SWW ${nl(c.waterOut, 1)} °C uit`;
  $('waterLabelCold').textContent = `${nl(c.values.waterInTemp, 0)} °C in`;

  $('stateTableBody').innerHTML = c.states.map(s => `<tr><td>${escapeXml(s.id)}</td><td>${escapeXml(s.label)}</td><td>${nl(bar(s.p), 2)}</td><td>${nl(s.t - 273.15, 2)}</td><td>${nl(kj(s.h), 2)}</td><td>${nl(kj(s.s), 3)}</td><td>${nl(s.massFlow, 4)}</td></tr>`).join('');
  const energyRows = [
    ['Koelvermogen', c.qEvap], ['LP-compressor', c.wLow], ['HP-compressor', c.wHigh],
    ['Intercooler', c.qIntercooler], ['Warmteterugwinning', c.qHeatRecovery], ['Resterende gaskoelerlast', c.qGasCooler]
  ];
  $('energyList').innerHTML = energyRows.map(([name, value]) => `<dt>${name}</dt><dd>${nl(value, 2)} kW</dd>`).join('');
  if (c.warnings.length) {
    $('warningBanner').innerHTML = `<strong>Aandachtspunt${c.warnings.length > 1 ? 'en' : ''}:</strong> ${c.warnings.map(escapeXml).join(' ')}`;
    $('warningBanner').classList.remove('hidden');
  } else $('warningBanner').classList.add('hidden');
  $('errorBanner').classList.add('hidden');
  drawDiagram(c);
}

function showError(error) {
  console.error(error);
  $('errorBanner').textContent = `Berekening niet mogelijk: ${error.message || error}`;
  $('errorBanner').classList.remove('hidden');
}

function svgEl(name, attrs = {}, text = '') {
  const el = document.createElementNS(svgNS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== '') el.textContent = text;
  return el;
}

const plot = { left: 78, right: 955, top: 35, bottom: 550, hMin: 80, hMax: 620, pMin: 5, pMax: 145 };
function xH(h) { return plot.left + (kj(h) - plot.hMin) / (plot.hMax - plot.hMin) * (plot.right - plot.left); }
function yP(p) { return plot.bottom - (Math.log10(bar(p)) - Math.log10(plot.pMin)) / (Math.log10(plot.pMax) - Math.log10(plot.pMin)) * (plot.bottom - plot.top); }
function validPlotPoint(pt) { return pt && Number.isFinite(pt.h) && Number.isFinite(pt.p) && xH(pt.h) >= plot.left - 10 && xH(pt.h) <= plot.right + 10 && yP(pt.p) >= plot.top - 10 && yP(pt.p) <= plot.bottom + 10; }
function pathFrom(points) { return points.filter(validPlotPoint).map((pt, i) => `${i ? 'L' : 'M'}${xH(pt.h).toFixed(1)},${yP(pt.p).toFixed(1)}`).join(' '); }

function addPath(svg, points, cls) {
  let segment = [];
  const flush = () => { if (segment.length > 1) svg.appendChild(svgEl('path', { d: pathFrom(segment), class: cls })); segment = []; };
  for (const p of points) {
    if (!validPlotPoint(p)) { flush(); continue; }
    if (segment.length && Math.abs(kj(p.h - segment.at(-1).h)) > 120) flush();
    segment.push(p);
  }
  flush();
}

function drawDiagram(c) {
  const svg = $('phDiagram');
  svg.replaceChildren();
  svg.appendChild(svgEl('rect', { x:0, y:0, width:1000, height:610, rx:14, fill:'#081a29' }));
  const hTicks = [100,200,300,400,500,600];
  const pTicks = [5,10,20,30,40,60,80,100,140];
  hTicks.forEach(h => { const x=xH(h*1000); svg.appendChild(svgEl('line',{x1:x,y1:plot.top,x2:x,y2:plot.bottom,class:'chart-grid'})); svg.appendChild(svgEl('text',{x,y:plot.bottom+24,'text-anchor':'middle',class:'chart-label'},h)); });
  pTicks.forEach(p => { const y=yP(pa(p)); svg.appendChild(svgEl('line',{x1:plot.left,y1:y,x2:plot.right,y2:y,class:'chart-grid'})); svg.appendChild(svgEl('text',{x:plot.left-12,y:y+4,'text-anchor':'end',class:'chart-label'},p)); });
  svg.appendChild(svgEl('line',{x1:plot.left,y1:plot.bottom,x2:plot.right,y2:plot.bottom,class:'chart-axis'}));
  svg.appendChild(svgEl('line',{x1:plot.left,y1:plot.top,x2:plot.left,y2:plot.bottom,class:'chart-axis'}));
  svg.appendChild(svgEl('text',{x:(plot.left+plot.right)/2,y:598,'text-anchor':'middle',class:'chart-label'},'Specifieke enthalpie h [kJ/kg]'));
  const yl=svgEl('text',{x:18,y:(plot.top+plot.bottom)/2,transform:`rotate(-90 18 ${(plot.top+plot.bottom)/2})`,'text-anchor':'middle',class:'chart-label'},'Druk p [bar] · log-schaal'); svg.appendChild(yl);

  if (baseDiagram?.dome?.length) {
    const liquid = baseDiagram.dome.map(d=>({p:d.p,h:d.hl}));
    const vapor = [...baseDiagram.dome].reverse().map(d=>({p:d.p,h:d.hv}));
    svg.appendChild(svgEl('path',{d:pathFrom([...liquid,...vapor])+' Z',class:'dome'}));
    const critical = baseDiagram.dome.at(-1);
    if (critical) svg.appendChild(svgEl('circle',{cx:xH((critical.hl+critical.hv)/2),cy:yP(critical.p),r:5,class:'critical'}));
  }
  if (c.values.showIsotherms && baseDiagram?.isotherms) baseDiagram.isotherms.forEach(line=>addPath(svg,line.points,'isotherm'));
  if (c.values.showQuality && optionalDiagram.quality) optionalDiagram.quality.forEach(line=>addPath(svg,line.points,'quality-line'));
  if (c.values.showIsentropes && optionalDiagram.isentropes) optionalDiagram.isentropes.forEach(line=>addPath(svg,line.points,'isentropic'));

  const b=c.byId;
  addPath(svg,[b['9'],b['10'],b['1'],b['2'],b['3'],b['5']],'cycle-low');
  addPath(svg,[b['5'],b['6'],...(c.values.heatRecoveryEnabled ? [b['6a']] : []),b['7'],b['8']],'cycle-high');
  addPath(svg,[b['8'],b['4'],b['5']],'cycle-flash');
  const colors = { '4':'#bb8cff','6':'#ff9b54','6a':'#ff9b54','7':'#ff9b54','8':'#ff9b54' };
  c.states.forEach((s,i)=>{
    if (!validPlotPoint(s)) return;
    const g=svgEl('g',{class:'chart-point'}); const fill=colors[s.id]||'#35d0ff';
    g.appendChild(svgEl('circle',{cx:xH(s.h),cy:yP(s.p),r:7,fill}));
    const dx = ['2','3','6','6a'].includes(s.id) ? 9 : -9;
    const anchor = dx>0?'start':'end';
    g.appendChild(svgEl('text',{x:xH(s.h)+dx,y:yP(s.p)-10,'text-anchor':anchor},s.id));
    const title=svgEl('title',{},`${s.id} · ${s.label}\n${nl(bar(s.p),2)} bar · ${nl(s.t-273.15,2)} °C · ${nl(kj(s.h),2)} kJ/kg`); g.appendChild(title);
    svg.appendChild(g);
  });
}

async function buildBaseDiagram() {
  try {
    const cached = JSON.parse(localStorage.getItem(DIAGRAM_CACHE_KEY) || 'null');
    if (cached?.dome?.length && cached?.isotherms?.length) { baseDiagram = cached; $('diagramStatus').textContent = 'Isolijnen uit lokale cache.'; drawDiagram(currentCycle); return; }
  } catch { /* cache is optional */ }
  const myJob = ++diagramJob;
  $('diagramStatus').textContent = 'Verzadigingskoepel en isothermen worden op de achtergrond berekend…';
  const dome=[];
  for(let tc=-50;tc<=30.5;tc+=1.5){
    const t=cToK(tc), p=tryPs('P','T',t,'Q',0), hl=tryPs('Hmass','T',t,'Q',0), hv=tryPs('Hmass','T',t,'Q',1);
    if([p,hl,hv].every(Number.isFinite)) dome.push({p,hl,hv,t});
    if(dome.length%10===0) await nextFrame();
    if(myJob!==diagramJob)return;
  }
  const isotherms=[];
  const temperatures=[-50,-40,-30,-20,-10,0,10,20,31,40,60,80,100,140];
  for(const tc of temperatures){
    const points=[];
    for(let i=0;i<50;i++){
      const p=pa(plot.pMin*Math.pow(plot.pMax/plot.pMin,i/49));
      points.push({p,h:tryPs('Hmass','P',p,'T',cToK(tc))});
    }
    isotherms.push({tc,points});
    await nextFrame();
    if(myJob!==diagramJob)return;
  }
  baseDiagram={dome,isotherms};
  try { localStorage.setItem(DIAGRAM_CACHE_KEY,JSON.stringify(baseDiagram)); } catch { /* quota/private mode */ }
  $('diagramStatus').textContent='CoolProp-isolijnen gereed.';
  if(currentCycle) drawDiagram(currentCycle);
}

async function ensureQualityLines() {
  if(optionalDiagram.quality || !baseDiagram?.dome) return;
  $('diagramStatus').textContent='Dampgehaltelijnen worden berekend…';
  optionalDiagram.quality=[0.2,0.4,0.6,0.8].map(q=>({q,points:baseDiagram.dome.map(d=>({p:d.p,h:d.hl+q*(d.hv-d.hl)}))}));
  $('diagramStatus').textContent='Dampgehaltelijnen gereed.';
}

async function ensureIsentropes(c) {
  if(optionalDiagram.isentropes) return;
  $('diagramStatus').textContent='Isentropen worden berekend…';
  const sMin=Math.min(c.byId['1'].s,c.byId['5'].s)*0.92, sMax=Math.max(c.byId['2'].s,c.byId['6'].s)*1.05;
  const entropies=Array.from({length:6},(_,i)=>sMin+(sMax-sMin)*i/5);
  optionalDiagram.isentropes=[];
  for(const s of entropies){
    const points=[];
    for(let i=0;i<45;i++){
      const p=pa(plot.pMin*Math.pow(plot.pMax/plot.pMin,i/44));
      points.push({p,h:tryPs('Hmass','P',p,'Smass',s)});
    }
    optionalDiagram.isentropes.push({s,points});
    await nextFrame();
  }
  $('diagramStatus').textContent='Isentropen gereed.';
}

async function recalculate() {
  if(!CP)return;
  try {
    updateControlOutputs();
    const v=inputs();
    currentCycle=calculateCycle(v);
    if(v.showQuality) await ensureQualityLines();
    if(v.showIsentropes) await ensureIsentropes(currentCycle);
    renderCycle(currentCycle);
  } catch(error) { showError(error); }
}

function scheduleCalculation() {
  updateControlOutputs();
  clearTimeout(calculationTimer);
  calculationTimer=setTimeout(recalculate,80);
}

function applyValues(values) {
  for(const [id,value] of Object.entries(values)) if($(id)) $(id).value=value;
  if('heatRecoveryEnabled' in values) $('heatRecoveryEnabled').checked=values.heatRecoveryEnabled;
  scheduleCalculation();
}

function downloadBlob(name, data, type) {
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([data],{type})); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function exportCsv() {
  if(!currentCycle)return;
  const rows=[['punt','beschrijving','druk_bar','temperatuur_C','enthalpie_kJ_kg','entropie_kJ_kgK','massadebiet_kg_s'],...currentCycle.states.map(s=>[s.id,s.label,bar(s.p),s.t-273.15,kj(s.h),kj(s.s),s.massFlow])];
  const csv=rows.map(row=>row.map(v=>`"${String(v).replaceAll('"','""')}"`).join(';')).join('\r\n');
  downloadBlob('r744-toestandspunten.csv','\ufeff'+csv,'text/csv;charset=utf-8');
}
function exportSvg() {
  if(!currentCycle)return;
  const clone=$('phDiagram').cloneNode(true); clone.setAttribute('xmlns',svgNS);
  const css=[...document.styleSheets].flatMap(sheet=>{try{return [...sheet.cssRules].map(r=>r.cssText)}catch{return[]}}).join('\n');
  clone.insertBefore(svgEl('style',{},css),clone.firstChild);
  downloadBlob('r744-logph-diagram.svg',new XMLSerializer().serializeToString(clone),'image/svg+xml');
}

function bindUi() {
  Object.keys(controlSpec).forEach(id=>$(id).addEventListener('input',scheduleCalculation));
  $('heatRecoveryEnabled').addEventListener('change',scheduleCalculation);
  ['showIsotherms','showQuality','showIsentropes'].forEach(id=>$(id).addEventListener('change',scheduleCalculation));
  document.querySelectorAll('[data-preset]').forEach(btn=>btn.addEventListener('click',()=>applyValues(presets[btn.dataset.preset])));
  $('resetBtn').addEventListener('click',()=>applyValues(defaults));
  $('csvBtn').addEventListener('click',exportCsv);
  $('svgBtn').addEventListener('click',exportSvg);
  updateControlOutputs();
}

async function init() {
  bindUi();
  if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
  try {
    setStatus('loading','CoolProp WASM laden…');
    CP=await CoolPropFactory({locateFile:path=>path.endsWith('.wasm')?new URL('./coolprop.wasm',import.meta.url).href:path});
    if(typeof CP.PropsSI!=='function') throw new Error('PropsSI is niet beschikbaar in deze CoolProp-build. Gebruik bij elkaar horende coolprop.js en coolprop.wasm.');
    setStatus('ready','CoolProp gereed');
    await recalculate();
    buildBaseDiagram().catch(error=>{console.warn(error);$('diagramStatus').textContent='Isolijnen konden niet volledig worden opgebouwd.';});
  } catch(error) {
    setStatus('error','CoolProp-fout');
    showError(error);
    $('stateTableBody').innerHTML='<tr><td colspan="7">Controleer of coolprop.js en coolprop.wasm samen in dezelfde map staan.</td></tr>';
  }
}

init();
