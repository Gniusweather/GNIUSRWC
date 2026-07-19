/* RWC weather-alert pusher — runs on GitHub Actions (30-min cron).
   Checks live Curaçao conditions + NHC tropical activity and sends a push
   notification through ntfy.sh, so phones get alerts even with the app
   fully closed (subscribe to the topic in the ntfy app).
   Mirrors the in-app service-worker checker (sw.js checkWeatherAlerts).
   Toggles/thresholds come from wx-alerts.config.json at the repo root, so
   the server cron can be tuned to match the in-app alert settings. */

const TOPIC   = process.env.NTFY_TOPIC || 'rwc-abc-wx-gnius21-4q7kp2';
const APP_URL = 'https://curcams.generast.workers.dev/';
const TEST    = process.env.WX_TEST === '1';

import fs from 'node:fs';
const stateDir = '.wx-state';
const stateFile = stateDir + '/last.txt';

// Alert preferences — defaults mirror the in-app ones (sw.js DEFAULT_PREFS);
// wx-alerts.config.json overrides them when present.
const DEFAULTS = { wind: true, windKt: 30, storm: true, showers: true, rain: true, rainPct: 70, tropical: true };
function loadConfig(){
  const cfg = { ...DEFAULTS };
  try{
    const raw = JSON.parse(fs.readFileSync('wx-alerts.config.json', 'utf8'));
    for(const k of Object.keys(DEFAULTS)) if(raw[k] != null) cfg[k] = raw[k];
  }catch(e){ console.log('No wx-alerts.config.json — using defaults.'); }
  return cfg;
}

async function main(){
  const P = loadConfig();
  console.log('Alert config:', JSON.stringify(P));
  const alerts = [];

  // Live conditions + next-3h rain chance (Open-Meteo, Hato/Curaçao)
  try{
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=12.19&longitude=-68.96' +
      '&current=wind_gusts_10m,weather_code,precipitation' +
      '&hourly=precipitation_probability&forecast_days=1' +
      '&timezone=America%2FCuracao&wind_speed_unit=kn';
    const j = await (await fetch(url)).json();
    const cur = j.current || {};
    if(P.wind && cur.wind_gusts_10m >= P.windKt) alerts.push('Strong wind: gusts ' + Math.round(cur.wind_gusts_10m) + ' kt');
    if(P.storm && cur.weather_code >= 95) alerts.push('Thunderstorm activity near Curacao');
    else if(P.showers && cur.weather_code >= 80 && cur.precipitation >= 2) alerts.push('Heavy showers now (' + cur.precipitation + ' mm)');
    const h = new Date(Date.now() - 4 * 3600e3).getUTCHours();   // AST hour
    const pops = ((j.hourly || {}).precipitation_probability || []).slice(h, h + 3).map(Number).filter(Number.isFinite);
    const pop = Math.max(0, ...pops);
    if(P.rain && pop >= P.rainPct) alerts.push('High rain chance next hours: ' + Math.round(pop) + '%');
  }catch(e){ console.error('open-meteo check failed:', e.message); }

  // Active Atlantic tropical systems (NHC)
  if(P.tropical) try{
    const sj = await (await fetch('https://www.nhc.noaa.gov/CurrentStorms.json')).json();
    const act = (sj.activeStorms || []).filter(s => /^AL/i.test(s.id || ''));
    if(act.length) alerts.push('Active Atlantic tropical system: ' + act.map(s => s.name).join(', '));
  }catch(e){ console.error('NHC check failed:', e.message); }

  // Dedupe across runs (state restored/saved via actions/cache)
  const key = alerts.join('|');
  let prev = '';
  try{ prev = fs.readFileSync(stateFile, 'utf8'); }catch(e){}
  fs.mkdirSync(stateDir, {recursive: true});
  fs.writeFileSync(stateFile, key);

  if(TEST){
    alerts.length = 0;
    alerts.push('Test alert — closed-app pushes are working. ' + new Date().toISOString());
  } else {
    if(!alerts.length){ console.log('No alert conditions.'); return; }
    if(key === prev){ console.log('Alert state unchanged — not re-sending.'); return; }
  }

  const res = await fetch('https://ntfy.sh/' + TOPIC, {
    method: 'POST',
    headers: {
      'Title': 'RWC Weather Alert',
      'Priority': TEST ? 'default' : 'high',
      'Tags': TEST ? 'white_check_mark' : 'warning',
      'Click': APP_URL
    },
    body: alerts.join('\n')
  });
  console.log('ntfy publish:', res.status, '· topic:', TOPIC, '·', alerts.join(' | '));
  if(!res.ok) process.exit(1);
}
main();
