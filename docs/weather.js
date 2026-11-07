/* מזג אוויר לקיבוץ שניר מ-Open-Meteo (חינמי, בלי מפתח). מודל: ECMWF IFS, שנמדד כמדויק ביותר לאזור; best_match כגיבוי. */
(function (root) {
  const LAT = 33.2375, LON = 35.6697;
  const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,relative_humidity_2m_max,relative_humidity_2m_min';
  const CURRENT = 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day,precipitation';
  const TTL = 30 * 60 * 1000;

  const url = (model) => `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&models=${model}&daily=${DAILY}&current=${CURRENT}&timezone=Asia%2FJerusalem&forecast_days=7`;

  async function fetchWeather() {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem('vg.weather') || 'null'); } catch (e) { /* ignore */ }
    if (cached && Date.now() - cached.at < TTL) return cached.data;
    let data = null;
    for (const model of ['ecmwf_ifs025', 'best_match']) {
      try {
        const j = await (await fetch(url(model))).json();
        if (j.daily && j.current) { data = { model, current: j.current, daily: j.daily }; break; }
      } catch (e) { /* try next model */ }
    }
    if (!data) { if (cached) return cached.data; throw new Error('אין תחזית כרגע'); }
    try { localStorage.setItem('vg.weather', JSON.stringify({ at: Date.now(), data })); } catch (e) { /* ignore */ }
    return data;
  }

  // WMO weather codes → icon kind + Hebrew label
  function describe(code, isDay) {
    if (code === 0) return { kind: isDay ? 'sun' : 'moon', text: 'בהיר' };
    if (code <= 2) return { kind: isDay ? 'sun-cloud' : 'moon-cloud', text: 'מעונן חלקית' };
    if (code === 3) return { kind: 'cloud', text: 'מעונן' };
    if (code <= 48) return { kind: 'fog', text: 'ערפל' };
    if (code <= 57) return { kind: 'drizzle', text: 'טפטוף' };
    if (code <= 67) return { kind: 'rain', text: 'גשם' };
    if (code <= 77) return { kind: 'snow', text: 'שלג' };
    if (code <= 82) return { kind: 'rain', text: 'ממטרים' };
    if (code <= 86) return { kind: 'snow', text: 'ממטרי שלג' };
    return { kind: 'storm', text: 'סופת רעמים' };
  }

  // Greenhouse-relevant warnings. Vanilla: comfortable 21–32°C, suffers under 10°C and over 35°C, wants humidity above 70%.
  function alerts(w) {
    const out = [];
    const d = w.daily;
    for (let i = 0; i < Math.min(3, d.time.length); i++) {
      const when = i === 0 ? 'היום' : i === 1 ? 'מחר' : 'מחרתיים';
      if (d.temperature_2m_max[i] >= 35) out.push({ level: 'danger', text: `${when} חום של ${Math.round(d.temperature_2m_max[i])}°. לבדוק קירור וערפול.` });
      if (d.temperature_2m_min[i] <= 7) out.push({ level: 'danger', text: `${when} קור של ${Math.round(d.temperature_2m_min[i])}° בלילה. לבדוק חימום.` });
      else if (d.temperature_2m_min[i] <= 10) out.push({ level: 'warn', text: `${when} לילה קר (${Math.round(d.temperature_2m_min[i])}°). לוודא שהחימום פועל.` });
      if (d.wind_speed_10m_max[i] >= 45) out.push({ level: 'warn', text: `${when} רוח עד ${Math.round(d.wind_speed_10m_max[i])} קמ"ש. לבדוק יריעות ורשתות.` });
      if (d.precipitation_sum[i] >= 15) out.push({ level: 'info', text: `${when} גשם של ${Math.round(d.precipitation_sum[i])} מ"מ.` });
      if (i === 0 && d.relative_humidity_2m_min[i] < 40) out.push({ level: 'warn', text: 'לחות נמוכה היום. ערפול לא מספיק לבד, לבדוק את הצמחים.' });
    }
    return out;
  }

  function icon(kind) {
    const s = (inner) => `<svg class="wx wx-${kind}" viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
    const sun = '<g class="rays"><g stroke="currentColor" stroke-width="3" stroke-linecap="round">' + [0, 45, 90, 135, 180, 225, 270, 315].map((a) => `<line x1="32" y1="6" x2="32" y2="13" transform="rotate(${a} 32 32)"/>`).join('') + '</g></g><circle class="disc" cx="32" cy="32" r="12" fill="currentColor"/>';
    const cloud = (cls = '') => `<path class="cloud ${cls}" d="M20 48h26a10 10 0 0 0 1-20 14 14 0 0 0-27-3 9 9 0 0 0 0 23z" fill="currentColor"/>`;
    const drops = (n, cls) => '<g class="' + cls + '">' + Array.from({ length: n }, (_, i) => `<line x1="${22 + i * 10}" y1="50" x2="${20 + i * 10}" y2="58" stroke="currentColor" stroke-width="3" stroke-linecap="round" style="animation-delay:${i * 0.25}s"/>`).join('') + '</g>';
    switch (kind) {
      case 'sun': return s(sun);
      case 'moon': return s('<path class="disc" d="M40 10a18 18 0 1 0 14 28 14 14 0 0 1-14-28z" fill="currentColor"/>');
      case 'sun-cloud': return s(`<g transform="translate(-8 -8) scale(.75)">${sun}</g>${cloud('front')}`);
      case 'moon-cloud': return s('<path class="disc" d="M40 8a12 12 0 1 0 10 18 9 9 0 0 1-10-18z" fill="currentColor" opacity=".85"/>' + cloud('front'));
      case 'cloud': return s(cloud());
      case 'fog': return s('<g class="fog" stroke="currentColor" stroke-width="4" stroke-linecap="round"><line x1="12" y1="26" x2="52" y2="26"/><line x1="18" y1="36" x2="46" y2="36"/><line x1="12" y1="46" x2="52" y2="46"/></g>');
      case 'drizzle': return s(cloud() + drops(2, 'drops slow'));
      case 'rain': return s(cloud() + drops(3, 'drops'));
      case 'snow': return s(cloud() + '<g class="flakes" fill="currentColor">' + [22, 32, 42].map((x, i) => `<circle cx="${x}" cy="54" r="2.5" style="animation-delay:${i * 0.4}s"/>`).join('') + '</g>');
      case 'storm': return s(cloud() + '<path class="bolt" d="M34 44l-8 12h6l-2 8 9-13h-6z" fill="currentColor"/>');
      default: return s(cloud());
    }
  }

  const api = { fetchWeather, describe, alerts, icon, LAT, LON };
  if (typeof module !== 'undefined') module.exports = api;
  else root.WX = api;
})(this);
