'use strict';
/* Local AI Expense Tracker — all data stays on the device.
   Storage: native file via AndroidBridge (APK) or localStorage (browser/PWA).
   AI: built-in rule engine (always on) + optional local LLM over an
   OpenAI-compatible endpoint (Ollama / llama.cpp server / LM Studio). */

const APP_VERSION = '1.0.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- dates ---------------- */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseD = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const todayStr = () => ymd(new Date());
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 86400000) + 1; // inclusive
const fmtDay = s => { const d = parseD(s); return `${WD[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };

/* ---------------- state ---------------- */
const DEFAULT_CATS = [
  ['housing', 'Rent & Housing', '🏠', 'need'], ['groceries', 'Groceries', '🛒', 'need'],
  ['food', 'Eating Out', '🍽️', 'want'], ['transport', 'Transport & Fuel', '🚗', 'need'],
  ['utilities', 'Bills & Utilities', '💡', 'need'], ['health', 'Health', '💊', 'need'],
  ['shopping', 'Shopping', '🛍️', 'want'], ['entertainment', 'Entertainment', '🎬', 'want'],
  ['subscriptions', 'Subscriptions', '🔁', 'want'], ['education', 'Education', '📚', 'need'],
  ['travel', 'Travel', '✈️', 'want'], ['emi', 'EMI & Loans', '🏦', 'need'],
  ['family', 'Family & Gifts', '🎁', 'want'], ['savings', 'Savings & Investments', '📈', 'save'],
  ['other', 'Other', '📦', 'want'],
];
const freshState = () => ({
  version: 1,
  settings: {
    currency: 'INR', locale: 'en-IN', income: 0, fyStart: 0, theme: 'auto',
    ai: { url: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b', key: '', enabled: true },
  },
  categories: DEFAULT_CATS.map(([id, name, icon, kind]) => ({ id, name, icon, kind, budget: 0 })),
  tx: [],
  recurring: [],
  chat: [],
});

const Store = {
  native: typeof window.AndroidBridge !== 'undefined',
  load() {
    try {
      const raw = this.native ? window.AndroidBridge.load() : localStorage.getItem('expense-tracker-v1');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { console.error(e); return null; }
  },
  save(state) {
    const raw = JSON.stringify(state);
    try {
      if (this.native) { if (!window.AndroidBridge.save(raw)) throw new Error('native save failed'); }
      else localStorage.setItem('expense-tracker-v1', raw);
    } catch (e) { toast('⚠️ Could not save: ' + e.message); }
  },
};

let S = migrate(Store.load()) || freshState();
function migrate(s) {
  if (!s) return null;
  const f = freshState();
  s.settings = { ...f.settings, ...(s.settings || {}), ai: { ...f.settings.ai, ...((s.settings || {}).ai || {}) } };
  s.categories ||= f.categories; s.tx ||= []; s.recurring ||= []; s.chat ||= [];
  return s;
}
const save = () => { bump(); Store.save(S); };

const view = { tab: 'home', kind: 'month', anchor: new Date(), filterCat: '', search: '', allCats: false, openSecs: new Set() };

/* ---------------- formatting ---------------- */
let _fmt = {};
function money(v, compact = false) {
  const { currency, locale } = S.settings;
  if (compact && Math.abs(v) >= 1000) { // K / L / Cr for India, K / M / B elsewhere
    const units = locale === 'en-IN' ? [[1e7, 'Cr'], [1e5, 'L'], [1e3, 'K']] : [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    const [d, u] = units.find(([d]) => Math.abs(v) >= d);
    const n = v / d;
    return money(0).replace(/0([.,]0+)?/, (Math.abs(n) >= 10 ? Math.round(n) : Math.round(n * 10) / 10) + u);
  }
  const key = Math.abs(v) >= 100 || Number.isInteger(v) ? 'w' : 'd';
  try {
    _fmt[key] ||= new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: key === 'd' ? 2 : 0, maximumFractionDigits: key === 'd' ? 2 : 0 });
    return _fmt[key].format(v);
  } catch { return currency + ' ' + Math.round(v).toLocaleString(); }
}
const resetFmt = () => { _fmt = {}; };
const pct = v => (v >= 0 ? '+' : '') + Math.round(v * 100) + '%';
const catOf = id => S.categories.find(c => c.id === id) || { id, name: id || 'Other', icon: '📦', kind: 'want', budget: 0 };

/* ---------------- periods ---------------- */
function periodRange(kind, anchor) {
  const y = anchor.getFullYear(), m = anchor.getMonth(), fy = +S.settings.fyStart || 0;
  let s, e, label;
  if (kind === 'month') {
    s = new Date(y, m, 1); e = new Date(y, m + 1, 0); label = `${MONTHS[m]} ${y}`;
  } else if (kind === 'quarter') {
    const off = (m - fy + 12) % 12, qs = m - (off % 3), q = Math.floor(off / 3) + 1;
    s = new Date(y, qs, 1); e = new Date(y, qs + 3, 0);
    const fyY = m >= fy ? y : y - 1;
    label = fy ? `Q${q} FY${String(fyY).slice(2)}-${String(fyY + 1).slice(2)}` : `Q${q} ${y}`;
  } else {
    const fyY = m >= fy ? y : y - 1;
    s = new Date(fyY, fy, 1); e = new Date(fyY + 1, fy, 0);
    label = fy ? `FY ${fyY}-${String(fyY + 1).slice(2)}` : `${fyY}`;
  }
  const r = { kind, start: ymd(s), end: ymd(e), label, months: monthsBetween(s, e) };
  const t = todayStr();
  r.isCurrent = t >= r.start && t <= r.end;
  r.isFuture = r.start > t;
  r.effEnd = r.isCurrent ? t : r.end;          // end of elapsed part
  r.days = daysBetween(r.start, r.end);
  r.elapsed = r.isFuture ? 0 : daysBetween(r.start, r.effEnd);
  return r;
}
function monthsBetween(s, e) { return (e.getFullYear() - s.getFullYear()) * 12 + e.getMonth() - s.getMonth() + 1; }
function shiftAnchor(kind, anchor, n) {
  const step = kind === 'month' ? 1 : kind === 'quarter' ? 3 : 12;
  return new Date(anchor.getFullYear(), anchor.getMonth() + step * n, 1);
}
const prevRange = r => periodRange(r.kind, shiftAnchor(r.kind, parseD(r.start), -1));

/* ---------------- aggregation ---------------- */
const inRange = (t, r) => t.date >= r.start && t.date <= r.end;
const sum = arr => arr.reduce((a, t) => a + t.amount, 0);
// Derived data is cached per data version; save() and any wholesale state swap call bump().
let DATA_VER = 0;
const memo = new Map();
const bump = () => { DATA_VER++; memo.clear(); };
function cached(key, f) {
  const k = DATA_VER + '|' + todayStr() + '|' + key;
  if (!memo.has(k)) memo.set(k, f());
  return memo.get(k);
}
const expIn = r => cached('exp|' + r.start + '|' + r.end, () => S.tx.filter(t => t.type === 'expense' && inRange(t, r)));
// typical (median) non-recurring spend per category over all history, computed once per data version
const catStats = () => cached('catStats', () => {
  const by = {};
  for (const t of S.tx) if (t.type === 'expense' && !t.recurId) (by[t.cat] ||= []).push(t.amount);
  const out = {};
  for (const [c, a] of Object.entries(by)) out[c] = { med: median(a), n: a.length };
  return out;
});
const incTxIn = r => S.tx.filter(t => t.type === 'income' && inRange(t, r));
function byCat(txs) { const o = {}; for (const t of txs) o[t.cat] = (o[t.cat] || 0) + t.amount; return o; }
function incomeFor(r) {
  const tx = sum(incTxIn(r));
  if (tx > 0) return tx;
  const months = r.isCurrent ? monthsBetween(parseD(r.start), new Date()) : r.months;
  return (+S.settings.income || 0) * (r.isFuture ? 0 : months);
}
const budgetTotal = () => S.categories.reduce((a, c) => a + (+c.budget || 0), 0);
function lastMonths(n, endAnchor = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const r = periodRange('month', new Date(endAnchor.getFullYear(), endAnchor.getMonth() - i, 1));
    out.push({ r, total: sum(expIn(r)) });
  }
  return out;
}
// previous period's spend up to the same day offset (fair comparison mid-period)
function prevComparable(r) {
  const pr = prevRange(r);
  if (!r.isCurrent) { const tx = expIn(pr); return { pr, tx, total: sum(tx), partial: false }; }
  const cut = ymd(new Date(parseD(pr.start).getFullYear(), parseD(pr.start).getMonth(), parseD(pr.start).getDate() + r.elapsed - 1));
  const tx = expIn(pr).filter(t => t.date <= cut);
  return { pr, tx, total: sum(tx), partial: true };
}
// fixed/lumpy spend: recurring entries + one-off big items. Excluded from pace extrapolation.
function splitFixed(ex) {
  const st = catStats();
  let fixed = 0;
  for (const t of ex) {
    if (t.recurId) { fixed += t.amount; continue; }
    // a single item ≥3× the category's typical spend is a one-off, not a daily rate
    const cs = st[t.cat];
    if (cs && cs.n >= 3 && t.amount >= cs.med * 3) fixed += t.amount;
  }
  return { fixed, variable: sum(ex) - fixed };
}
const investedIn = ex => sum(ex.filter(t => catOf(t.cat).kind === 'save'));
const isVariableCat = (ex, cid) => ex.filter(t => t.cat === cid && !t.recurId).length >= 3;
function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

/* ---------------- recurring ---------------- */
function generateRecurring() {
  const today = new Date(); let added = 0;
  for (const rc of S.recurring) {
    let [y, m] = (rc.next || rc.start).split('-').map(Number); m -= 1;
    while (true) {
      const day = Math.min(rc.day, new Date(y, m + 1, 0).getDate());
      const d = new Date(y, m, day);
      if (d > today) break;
      S.tx.push({ id: uid(), type: rc.type, amount: rc.amount, cat: rc.cat, date: ymd(d), note: rc.note, recurId: rc.id });
      added++; m++; if (m > 11) { m = 0; y++; }
    }
    rc.next = `${y}-${pad(m + 1)}`;
  }
  if (added) save();
}

/* ---------------- insights engine (deterministic, offline) ---------------- */
function insights(r) { return cached('ins|' + r.kind + '|' + r.start, () => computeInsights(r)); }
function computeInsights(r) {
  const out = [];
  const add = (level, title, text, score = 0, key = '') => out.push({ level, title, text, score, key });
  const ex = expIn(r);
  const total = sum(ex);
  const pr = prevRange(r);
  const prevTotal = sum(expIn(pr));
  const allExp = S.tx.filter(t => t.type === 'expense');

  if (r.isFuture) return [{ level: 'info', title: 'Future period', text: 'Nothing to analyse yet.' }];
  if (allExp.length < 5) {
    add('info', 'Log a couple of weeks of expenses', 'Insights get useful after ~2 weeks of daily entries. Add everything, including small cash spends — the small stuff is where leaks hide.', 100);
  }

  // 1. total vs previous period (compare like-for-like elapsed days if current)
  if (prevTotal > 0 && total > 0) {
    const pc = prevComparable(r), cmpPrev = pc.total, note = pc.partial ? ` at the same point in ${pr.label}` : '';
    if (cmpPrev > 0) {
      const ch = total / cmpPrev - 1;
      if (ch > 0.15) add('warn', `Spending up ${pct(ch)} vs ${pr.label}`, `${money(total)} so far vs ${money(cmpPrev)}${note}.`, 60 + ch * 20, 'vsPrev');
      else if (ch < -0.1) add('good', `Spending down ${pct(ch)} vs ${pr.label}`, `${money(total)} vs ${money(cmpPrev)}${note}. Keep it up.`, 40, 'vsPrev');
    }
  }

  // 2. pace / projection (current month)
  // Investments (SIP etc.) are saving, not consumption: keep them out of the projection and its limit.
  const isSave = cid => catOf(cid).kind === 'save';
  const tb = S.categories.filter(c => c.kind !== 'save').reduce((a, c) => a + (+c.budget || 0), 0) * r.months;
  const consumption = ex.filter(t => !isSave(t.cat));
  const spent = sum(consumption);
  if (r.isCurrent && r.elapsed >= 3 && spent > 0) {
    const { fixed, variable } = splitFixed(consumption);
    const pendingRec = r.kind === 'month' ? S.recurring.filter(rc => rc.type === 'expense' && !isSave(rc.cat) && (rc.next || '') <= r.start.slice(0, 7)).reduce((a, rc) => a + rc.amount, 0) : 0;
    const projected = fixed + pendingRec + variable / r.elapsed * r.days;
    const limit = tb || incomeFor({ ...r, isCurrent: false });
    const excl = investedIn(ex) ? ' Investments are not counted as spending.' : '';
    if (limit > 0) {
      const lvl = projected > limit ? 'bad' : projected > limit * 0.9 ? 'warn' : 'good';
      const what = tb ? 'spending budget' : 'income';
      const dailyLeft = Math.max(0, (limit - spent - pendingRec) / Math.max(1, r.days - r.elapsed));
      add(lvl, `On track to spend ${money(projected)} this ${r.kind}`,
        `That's ${Math.round(projected / limit * 100)}% of your ${what} (${money(limit)}). To stay within it, keep day-to-day spending under ${money(dailyLeft)}/day for the remaining ${r.days - r.elapsed} days.${excl}`,
        lvl === 'bad' ? 95 : lvl === 'warn' ? 70 : 30);
    } else {
      add('info', `On track to spend ${money(projected)} this ${r.kind}`, `Set category budgets or your monthly income in Settings to see whether that is OK.${excl}`, 20);
    }
  }

  // 3. per-category budget status
  const bc = byCat(ex);
  const frac = r.elapsed / r.days;
  for (const c of S.categories) {
    const b = (+c.budget || 0) * r.months; if (!b) continue;
    const used = bc[c.id] || 0;
    if (used > b) add('bad', `${c.icon} ${c.name}: over budget by ${money(used - b)}`, `${money(used)} spent of ${money(b)} (${Math.round(used / b * 100)}%).`, 90 + used / b);
    else if (r.isCurrent && used / b > frac + 0.2 && used / b > 0.5 && isVariableCat(ex, c.id)) add('warn', `${c.icon} ${c.name}: ${Math.round(used / b * 100)}% of budget used`, `Only ${Math.round(frac * 100)}% of the ${r.kind} has passed. ${money(b - used)} left.`, 65);
  }

  // 4. category movers vs 3-period average
  const hist = [];
  let p = r;
  for (let i = 0; i < 3; i++) { p = prevRange(p); hist.push(byCat(expIn(p))); }
  const histN = hist.filter(h => Object.keys(h).length).length;
  if (histN >= 1 && total > 0) {
    let up = null, down = null;
    for (const c of S.categories) {
      const avg = hist.reduce((a, h) => a + (h[c.id] || 0), 0) / histN;
      const now = bc[c.id] || 0;
      if (avg <= 0) continue;
      // mid-period: only flag once you've already beaten a usual *full* period (robust to lumpy bills)
      const diff = now - avg;
      const hot = r.isCurrent ? now > avg * 1.1 : now > avg * 1.3;
      if (hot && diff > total * 0.05 && (!up || diff > up.diff)) up = { c, diff, now, avg };
      if (!r.isCurrent && now < avg * 0.7 && avg - now > total * 0.05 && (!down || avg - now > down.diff)) down = { c, diff: avg - now, now, avg };
    }
    if (up) add('warn', `${up.c.icon} ${up.c.name} is running hot`, `${money(up.now)} vs a usual ${money(up.avg)} per ${r.kind}${r.isCurrent ? `, and ${r.days - r.elapsed} days are still left` : ''}.`, 75);
    if (down) add('good', `${down.c.icon} ${down.c.name} cut by ${money(down.diff)}`, `${money(down.now)} vs a usual ${money(down.avg)}.`, 35);
  }

  // 5. savings rate
  const inc = incomeFor(r);
  if (inc > 0) {
    const saved = inc - total + investedIn(ex); // investments count as saving, not spending
    const sr = saved / inc;
    if (r.isCurrent && r.kind === 'month' && frac < 0.5) { /* too early to judge */ }
    else if (sr < 0) add('bad', `Spent ${money(-saved)} more than you earned`, `Income ${money(inc)}, spending ${money(total - investedIn(ex))} (excl. investments). This is drawing down savings or adding debt.`, 98);
    else if (sr < 0.1) add('warn', `Savings rate only ${Math.round(sr * 100)}%`, `Aim for at least 20%: that means spending ≤ ${money(inc * 0.8)} on this income.`, 80);
    else if (sr >= 0.2) add('good', `Savings rate ${Math.round(sr * 100)}%`, `You kept ${money(saved)} of ${money(inc)}${investedIn(ex) ? `, ${money(investedIn(ex))} of it invested` : ''}.`, 30);
    else add('info', `Savings rate ${Math.round(sr * 100)}%`, `Good start. ${money(inc * 0.2 - saved)} more saved would hit the 20% mark.`, 45);
  }

  // 6. needs / wants split (50/30/20)
  if (total > 0) {
    const k = { need: 0, want: 0, save: 0 };
    for (const t of ex) k[catOf(t.cat).kind] += t.amount;
    const base = inc > 0 ? inc : total;
    const wantShare = k.want / base;
    if (inc > 0 && wantShare > 0.3) add('warn', `Wants are ${Math.round(wantShare * 100)}% of income`, `50/30/20 rule suggests ≤30%. Trimming wants by ${money(k.want - inc * 0.3)} gets you there.`, 72);
    else if (inc === 0 && wantShare > 0.4) add('warn', `${Math.round(wantShare * 100)}% of spending is on wants`, `Needs ${money(k.need)}, wants ${money(k.want)}. Review the "want" categories first when cutting back.`, 55);
  }

  // 7. unusual transactions
  const unusual = [];
  const st = catStats();
  for (const t of ex) {
    if (t.recurId) continue;
    const cs = st[t.cat];
    if (!cs || cs.n < 6) continue;
    if (t.amount >= cs.med * 3 && t.amount > total * 0.05) unusual.push({ t, med: cs.med });
  }
  unusual.sort((a, b) => b.t.amount - a.t.amount).slice(0, 2).forEach(({ t, med }) =>
    add('info', `Unusually large: ${money(t.amount)} on ${catOf(t.cat).name}`, `${fmtDay(t.date)}${t.note ? ' — ' + t.note : ''}. Your typical ${catOf(t.cat).name.toLowerCase()} spend is ${money(med)}.`, 50));

  // 8. habit spends: the most frequent discretionary category (one card, not one per category)
  const days = Math.max(1, r.elapsed);
  let habit = null;
  for (const [cid, amt] of Object.entries(bc)) {
    const n = ex.filter(t => t.cat === cid && !t.recurId).length;
    if (catOf(cid).kind !== 'want' || n < Math.max(6, days / 4)) continue;
    if (!habit || amt > habit.amt) habit = { c: catOf(cid), amt, n };
  }
  if (habit) {
    const perMonth = habit.amt / days * 30;
    add('info', `${habit.n} ${habit.c.name.toLowerCase()} purchases in ${days} days`,
      `${money(habit.amt)} total, ${money(habit.amt / habit.n)} each on average.${r.isCurrent ? ` At this pace that's ~${money(perMonth)} a month.` : ''} Doing it half as often saves ~${money(perMonth / 2)}/month (${money(perMonth * 6)}/year).`, 58);
  }

  // 9. weekend effect
  if (ex.length >= 15) {
    let we = 0, wd = 0, weD = 0, wdD = 0;
    for (let d = parseD(r.start); ymd(d) <= r.effEnd; d.setDate(d.getDate() + 1)) (d.getDay() % 6 === 0 ? weD++ : wdD++);
    for (const t of ex) { if (t.recurId) continue; (parseD(t.date).getDay() % 6 === 0 ? (we += t.amount) : (wd += t.amount)); }
    if (weD && wdD) {
      const a = we / weD, b = wd / wdD;
      if (a > b * 1.6) add('info', `Weekends cost ${(a / b).toFixed(1)}× more per day`, `${money(a)}/day on weekends vs ${money(b)}/day on weekdays. Plan weekends with a cap.`, 48);
    }
  }

  // 10. subscriptions
  const subs = S.recurring.filter(x => x.type === 'expense' && (x.cat === 'subscriptions' || catOf(x.cat).kind === 'want'));
  const subsTotal = subs.reduce((a, x) => a + x.amount, 0);
  const subsSpent = bc.subscriptions || 0;
  if (subsTotal > 0 || subsSpent > 0) {
    const m = Math.max(subsTotal, subsSpent / r.months);
    const incM = inc > 0 ? inc / r.months : 0;
    if (incM && m / incM > 0.05) add('warn', `Subscriptions ≈ ${money(m)}/month`, `${Math.round(m / incM * 100)}% of income — that's ${money(m * 12)}/year. Cancel anything unused in the last 30 days.`, 62);
    else add('info', `Subscriptions ≈ ${money(m)}/month`, `${money(m * 12)}/year. Audit them every quarter.`, 25);
  }

  // 11. no-spend days
  if (r.kind === 'month' && r.elapsed >= 7) {
    const spendDays = new Set(ex.filter(t => !t.recurId).map(t => t.date)).size;
    const free = r.elapsed - spendDays;
    if (free >= 4) add('good', `${free} no-spend days`, 'Days with zero discretionary spend. Try adding one more each week.', 15);
  }

  // 12. top category share
  if (total > 0) {
    const [topId, topAmt] = Object.entries(bc).sort((a, b) => b[1] - a[1])[0];
    const share = topAmt / total;
    if (share > 0.35 && catOf(topId).kind !== 'need') add('warn', `${catOf(topId).name} is ${Math.round(share * 100)}% of spending`, 'One discretionary category dominating spending is the easiest place to cut.', 66);
  }

  if (!out.length && total > 0) add('good', 'Nothing alarming', 'No budget overruns, spikes, or unusual transactions in this period.', 1);
  if (!budgetTotal() && S.tx.length >= 5) add('info', 'Set budgets to unlock pace tracking', 'Settings → Categories: give each category a monthly budget.', 10);
  return out.sort((a, b) => b.score - a.score);
}

/* ---------------- LLM (OpenAI-compatible, local) ---------------- */
function financeContext(r) {
  const cur = S.settings.currency;
  const L = [];
  L.push(`Today: ${todayStr()}. Currency: ${cur}. Monthly income (declared): ${S.settings.income ? money(+S.settings.income) : 'not set'}.`);
  L.push(`Selected period: ${r.label} (${r.start} to ${r.end}${r.isCurrent ? `, ${r.elapsed}/${r.days} days elapsed` : ''}).`);
  const budgets = S.categories.filter(c => +c.budget).map(c => `${c.name} ${money(+c.budget)}`);
  L.push(`Monthly budgets: ${budgets.length ? budgets.join(', ') : 'none set'}.`);
  L.push(`Category types: ` + S.categories.map(c => `${c.name}=${c.kind}`).join(', ') + '.');
  // monthly by category, last 6 months
  const months = lastMonths(6);
  const cats = S.categories.filter(c => months.some(m => sum(expIn(m.r).filter(t => t.cat === c.id)) > 0));
  L.push('\nSpending by month (last 6 months):');
  L.push(['Month', 'Total', 'Income', ...cats.map(c => c.name)].join(' | '));
  for (const m of months) {
    const bc = byCat(expIn(m.r));
    L.push([m.r.label, Math.round(m.total), Math.round(incomeFor(m.r)), ...cats.map(c => Math.round(bc[c.id] || 0))].join(' | '));
  }
  L.push('\nQuarter totals:');
  let q = periodRange('quarter', new Date());
  const qs = [];
  for (let i = 0; i < 4; i++) { qs.unshift(`${q.label}: ${Math.round(sum(expIn(q)))}`); q = prevRange(q); }
  L.push(qs.join('; '));
  const rec = S.recurring.map(x => `${catOf(x.cat).name} ${money(x.amount)} on day ${x.day}${x.note ? ' (' + x.note + ')' : ''}`);
  if (rec.length) L.push('\nRecurring: ' + rec.join('; '));
  L.push('\nRule-engine findings for the selected period:');
  insights(r).slice(0, 10).forEach(i => L.push(`- [${i.level}] ${i.title}: ${i.text}`));
  L.push('\nRecent transactions (newest first):');
  [...S.tx].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40)
    .forEach(t => L.push(`${t.date} ${t.type === 'income' ? '+' : '-'}${Math.round(t.amount)} ${catOf(t.cat).name}${t.note ? ' "' + t.note + '"' : ''}`));
  return L.join('\n');
}
const SYSTEM_PROMPT = `You are a blunt, practical personal-finance coach inside a private, offline expense tracker.
Rules:
- Use ONLY the user's data below. Quote concrete numbers and categories. Never invent transactions.
- Be specific and actionable: name the category, the amount to cut, and how.
- Keep answers short: max ~180 words, bullet points preferred.
- If data is insufficient, say exactly what to log.
- No generic disclaimers.`;

async function llmChat(messages, onToken, signal) {
  const ai = S.settings.ai;
  const base = ai.url.replace(/\/+$/, '').replace(/\/v1$/, '');
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(ai.key ? { Authorization: 'Bearer ' + ai.key } : {}) },
    body: JSON.stringify({ model: ai.model, messages, stream: true, temperature: 0.3 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let full = '';
  if (!res.body || !res.body.getReader) { // non-streaming fallback
    const j = await res.json(); full = j.choices?.[0]?.message?.content || ''; onToken(full); return full;
  }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return full;
      try { const d = JSON.parse(data).choices?.[0]?.delta?.content; if (d) { full += d; onToken(full); } } catch { }
    }
  }
  return full;
}
async function llmModels() {
  const ai = S.settings.ai;
  const base = ai.url.replace(/\/+$/, '').replace(/\/v1$/, '');
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(base + '/v1/models', { signal: ctl.signal, headers: ai.key ? { Authorization: 'Bearer ' + ai.key } : {} });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return (j.data || []).map(m => m.id);
  } finally { clearTimeout(tm); }
}
function md(s) { // tiny, safe markdown: escape first, then format
  const lines = esc(s).split('\n'); let html = '', inList = false;
  const inline = t => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const ln of lines) {
    const li = ln.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
    if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    const h = ln.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h4>${inline(h[1])}</h4>`;
    else if (ln.trim()) html += `<p>${inline(ln)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

/* ---------------- charts (hand-rolled SVG, no deps) ---------------- */
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
function barChart(items, { selIdx = -1, avg = null, height = 170 } = {}) {
  // items: [{label, value, tip}]
  const W = 340, H = height, padL = 40, padB = 20, padT = 14;
  const max = niceMax(Math.max(...items.map(i => i.value), avg || 0));
  const n = items.length, slot = (W - padL) / n, bw = Math.min(26, slot * 0.62);
  const y = v => padT + (H - padT - padB) * (1 - v / max);
  let g = '<g class="grid axis">';
  for (let k = 0; k <= 2; k++) {
    const v = max * k / 2, yy = y(v);
    g += `<line x1="${padL}" x2="${W}" y1="${yy}" y2="${yy}"/><text x="${padL - 6}" y="${yy + 3}" text-anchor="end">${esc(money(v, true))}</text>`;
  }
  g += '</g>';
  let bars = '', labels = '<g class="axis">';
  const every = n > 8 ? 2 : 1;
  items.forEach((it, i) => {
    const cx = padL + slot * i + slot / 2, x = cx - bw / 2, top = y(it.value), h = Math.max(0, H - padB - top);
    const r = Math.min(4, h / 2, bw / 2);
    const path = h > 0 ? `M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z` : '';
    const cls = selIdx < 0 || i === selIdx ? 'bar' : 'bar dim';
    bars += `<rect class="hit" data-tip="${esc(it.tip)}" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT}"/>`;
    if (path) bars += `<path class="${cls}" d="${path}" pointer-events="none"/>`;
    if (i % every === (n - 1) % every) labels += `<text x="${cx}" y="${H - 5}" text-anchor="middle">${esc(it.label)}</text>`;
  });
  labels += '</g>';
  let avgLine = '';
  if (avg) avgLine = `<line class="avg" x1="${padL}" x2="${W}" y1="${y(avg)}" y2="${y(avg)}"/><text class="avgl" x="${W}" y="${y(avg) - 4}" text-anchor="end">avg ${esc(money(avg, true))}</text>`;
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img">${g}${bars}${avgLine}${labels}</svg></div>`;
}
function bindTips(root) {
  const tip = $('#tip');
  const show = e => {
    const t = e.target.closest('[data-tip]'); if (!t) return;
    const b = t.getBoundingClientRect();
    tip.textContent = t.dataset.tip; tip.hidden = false;
    tip.style.left = clamp(b.left + b.width / 2, 70, innerWidth - 70) + 'px';
    tip.style.top = Math.max(40, (e.touches ? e.touches[0].clientY : e.clientY) - 4) + 'px';
  };
  const hide = () => { tip.hidden = true; };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerdown', show);
  root.addEventListener('pointerleave', hide);
  document.addEventListener('scroll', hide, { passive: true, once: true });
}

/* ---------------- UI helpers ---------------- */
let toastT;
function toast(msg, ms = 2200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function openSheet(html, bind) {
  const sh = $('#sheet'); $('.sheet-body', sh).innerHTML = html; sh.hidden = false;
  bind && bind($('.sheet-body', sh));
}
function closeSheet() { $('#sheet').hidden = true; }
function ask(msg, ok = 'Confirm', danger = true) {
  return new Promise(res => openSheet(`<h3>${esc(msg)}</h3><div class="btns"><button class="btn" id="qno">Cancel</button><button class="btn ${danger ? 'pri danger-pri' : 'pri'}" id="qyes">${esc(ok)}</button></div>`, b => {
    $('#qno', b).onclick = () => { closeSheet(); res(false); };
    $('#qyes', b).onclick = () => { closeSheet(); res(true); };
  }));
}
const insHTML = i => `<div class="ins ${i.level}"><div class="i">${{ good: '✓', warn: '!', bad: '✕', info: 'i' }[i.level]}</div><div class="h">${esc(i.title)}</div><div class="b">${esc(i.text)}</div></div>`;
function applyTheme() {
  const t = S.settings.theme, el = document.documentElement;
  if (t !== 'auto') el.dataset.theme = t;
  else if (Store.native && window.AndroidBridge.isNightMode) el.dataset.theme = window.AndroidBridge.isNightMode() ? 'dark' : 'light';
  else el.removeAttribute('data-theme');
}

/* ---------------- views ---------------- */
function render() {
  const r = periodRange(view.kind, view.anchor);
  $('#periodLabel').textContent = r.label;
  $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.kind === view.kind));
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === view.tab));
  document.body.classList.toggle('hide-period', view.tab === 'settings');
  $('#title').hidden = view.tab !== 'settings';
  $('#fab').hidden = view.tab === 'settings';
  const v = $('#view');
  ({ home: renderHome, history: renderHistory, insights: renderInsights, settings: renderSettings })[view.tab](v, r);
}

function renderHome(v, r) {
  if (!S.tx.length) {
    v.innerHTML = `<div class="card welcome"><h2>Track every rupee, spot the leaks</h2>
      <p class="sub">Add expenses by category as they happen. You get monthly and quarterly views, budget tracking and an AI coach that reads your actual numbers.</p>
      <div class="btns"><button class="btn pri" id="w-add">Add first expense</button><button class="btn" id="w-demo">Try with demo data</button></div>
      <p class="sub muted" style="margin-top:10px">Demo data is 6 months of sample entries. Remove it any time in Settings.</p></div>`;
    $('#w-add', v).onclick = () => editTx(null);
    $('#w-demo', v).onclick = () => { loadDemo(); render(); toast('Demo data loaded'); };
    return;
  }
  const ex = expIn(r), total = sum(ex), pc = prevComparable(r), pr = pc.pr, prevTotal = pc.total;
  const inc = incomeFor(r), tb = budgetTotal() * r.months, inv = investedIn(ex), saved = inc - total + inv;
  const dailyAvg = r.elapsed ? total / r.elapsed : 0;
  const ch = prevTotal ? total / prevTotal - 1 : null;
  let html = `<div class="kpis">
    <div class="kpi hero"><div class="l">Spent · ${esc(r.label)}</div><div class="v">${money(total)}</div>
      <div class="d">${ch === null ? 'No data for ' + esc(pr.label) : `<span class="${ch > 0 ? 'up' : 'down'}">${ch > 0 ? '▲' : '▼'} ${pct(ch).replace('+', '')}</span> vs ${esc(pr.label)}${pc.partial ? ' at same day' : ''} (${money(prevTotal)})`}</div></div>
    <div class="kpi"><div class="l">${tb ? 'Budget left' : 'Daily average'}</div><div class="v ${tb && total > tb ? 'up' : ''}">${tb ? money(tb - total) : money(dailyAvg)}</div><div class="d">${tb ? `of ${money(tb)} · ${Math.round(total / tb * 100)}% used` : `over ${r.elapsed} days`}</div></div>
    <div class="kpi"><div class="l">${inc ? 'Saved' : 'Transactions'}</div><div class="v ${inc && saved < 0 ? 'up' : ''}">${inc ? money(saved) : ex.length}</div><div class="d">${inc ? `${Math.round(saved / inc * 100)}% of ${money(inc)} income${inv ? ` · ${money(inv, true)} invested` : ''}` : 'set income in Settings'}</div></div>
  </div>`;

  // top insights
  const all = insights(r).filter(i => i.key !== 'vsPrev');
  const bad = all.filter(i => i.level === 'bad' || i.level === 'warn'), good = all.filter(i => i.level === 'good');
  const ins = [...bad.slice(0, 2), ...good.slice(0, 1)];
  if (ins.length < 3) ins.push(...all.filter(i => i.level === 'info').slice(0, 3 - ins.length)); // never a third warning
  if (ins.length && S.tx.length) html += `<div class="card"><h2>Insights <small>tap AI tab for more</small></h2>${ins.map(insHTML).join('')}</div>`;

  // trend chart
  let items, sel = -1, title;
  if (view.kind === 'month') {
    const ms = lastMonths(12, view.anchor);
    items = ms.map(m => ({ label: MONTHS[parseD(m.r.start).getMonth()], value: m.total, tip: `${m.r.label}: ${money(m.total)}` }));
    sel = items.length - 1; title = 'Last 12 months';
  } else if (view.kind === 'quarter') {
    const qs = []; let q = r; for (let i = 0; i < 6; i++) { qs.unshift(q); q = prevRange(q); }
    items = qs.map(q => { const t = sum(expIn(q)); return { label: q.label.split(' ')[0] + (q.label.includes('FY') ? '' : "'" + q.start.slice(2, 4)), value: t, tip: `${q.label}: ${money(t)}` }; });
    sel = items.length - 1; title = 'Last 6 quarters';
  } else {
    const s = parseD(r.start);
    items = Array.from({ length: 12 }, (_, i) => { const mr = periodRange('month', new Date(s.getFullYear(), s.getMonth() + i, 1)); const t = sum(expIn(mr)); return { label: MONTHS[parseD(mr.start).getMonth()], value: t, tip: `${mr.label}: ${money(t)}` }; });
    title = 'Months in ' + r.label;
  }
  const nz = items.filter(i => i.value > 0);
  const avg = nz.length > 1 ? nz.reduce((a, i) => a + i.value, 0) / nz.length : null;
  html += `<div class="card" id="trend"><h2>Spending trend <small>${title}</small></h2>${barChart(items, { selIdx: sel, avg })}</div>`;

  // quarter: month split
  if (view.kind === 'quarter') {
    const s = parseD(r.start);
    const mi = [0, 1, 2].map(i => { const mr = periodRange('month', new Date(s.getFullYear(), s.getMonth() + i, 1)); const t = sum(expIn(mr)); return { label: MONTHS[parseD(mr.start).getMonth()], value: t, tip: `${mr.label}: ${money(t)}` }; });
    html += `<div class="card" id="qmonths"><h2>Months in ${esc(r.label)}</h2>${barChart(mi, { height: 130 })}</div>`;
  }

  // categories
  const bc = byCat(ex), pbc = byCat(pc.tx);
  const rows = S.categories.map(c => ({ c, amt: bc[c.id] || 0, b: (+c.budget || 0) * r.months, prev: pbc[c.id] || 0 }))
    .filter(x => x.amt > 0 || x.b > 0).sort((a, b) => b.amt - a.amt);
  const maxV = Math.max(1, ...rows.map(x => Math.max(x.amt, x.b)));
  const frac = r.isCurrent ? r.elapsed / r.days : 1;
  html += `<div class="card"><h2>By category <small>bar = spent · line = budget</small></h2>`;
  const shown = view.allCats ? rows : rows.slice(0, 6);
  html += rows.length ? shown.map(({ c, amt, b, prev }) => {
    const st = !b ? '' : amt > b ? 'over' : (amt / b > frac + 0.15 && amt / b > 0.5 && isVariableCat(ex, c.id)) ? 'risk' : '';
    const badge = !b ? '' : st === 'over' ? `<span class="badge bad">✕ Over ${money(amt - b)}</span>` : st === 'risk' ? `<span class="badge warn">! ${Math.round(amt / b * 100)}% used</span>` : `<span class="badge good">✓ ${money(b - amt)} left</span>`;
    const d = prev ? amt / prev - 1 : null;
    return `<div class="catrow" data-cat="${esc(c.id)}"><div class="ic">${c.icon}</div><div class="nm">${esc(c.name)}</div><div class="amt">${money(amt)}</div>
      <div class="track"><div class="fill ${st}" style="width:${amt / maxV * 100}%"></div>${b ? `<div class="mark" style="left:calc(${b / maxV * 100}% - 1px)"></div>` : ''}</div>
      <div class="meta"><span>${total ? Math.round(amt / total * 100) + '% of total' : ''}${d !== null && amt ? ` · ${pct(d)} vs prev` : ''}</span>${badge}</div></div>`;
  }).join('') : '<div class="empty">No expenses in this period.<br>Tap + to add one.</div>';
  if (rows.length > 6) html += `<button class="btn sm more" id="allcats">${view.allCats ? 'Show top 6' : `Show all ${rows.length} categories`}</button>`;
  html += '</div>';

  // quarterly table (category x month) for quarter / year
  if (view.kind !== 'month' && rows.length) {
    const s = parseD(r.start);
    const mrs = Array.from({ length: r.months }, (_, i) => periodRange('month', new Date(s.getFullYear(), s.getMonth() + i, 1)));
    const cols = view.kind === 'quarter' ? mrs : [0, 1, 2, 3].map(i => periodRange('quarter', new Date(s.getFullYear(), s.getMonth() + i * 3, 1)));
    html += `<div class="card"><h2>Breakdown table</h2><div class="scroll-x"><table class="t"><tr><th>Category</th>${cols.map(c => `<th>${esc(view.kind === 'quarter' ? c.label.split(' ')[0] : c.label.split(' ')[0])}</th>`).join('')}<th>Total</th></tr>`;
    for (const { c, amt } of rows.filter(x => x.amt > 0)) html += `<tr><td>${c.icon} ${esc(c.name)}</td>${cols.map(cr => `<td>${cr.isFuture ? '–' : money(sum(expIn(cr).filter(t => t.cat === c.id)), true)}</td>`).join('')}<td><b>${money(amt, true)}</b></td></tr>`;
    html += `<tr><td><b>Total</b></td>${cols.map(cr => `<td><b>${cr.isFuture ? '–' : money(sum(expIn(cr)), true)}</b></td>`).join('')}<td><b>${money(total, true)}</b></td></tr></table></div></div>`;
  }

  v.innerHTML = html;
  $$('.chart', v).forEach(bindTips);
  $$('.catrow', v).forEach(el => el.onclick = () => { view.tab = 'history'; view.filterCat = el.dataset.cat; render(); });
  if ($('#allcats', v)) $('#allcats', v).onclick = () => { view.allCats = !view.allCats; render(); };
}

function renderHistory(v, r) {
  const q = view.search.toLowerCase();
  const list = S.tx.filter(t => inRange(t, r) && (!view.filterCat || t.cat === view.filterCat) &&
    (!q || (t.note || '').toLowerCase().includes(q) || catOf(t.cat).name.toLowerCase().includes(q) || String(t.amount).includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.id > a.id ? 1 : -1));
  const days = {};
  for (const t of list) (days[t.date] ||= []).push(t);
  let html = `<div class="filters"><input id="hs" type="search" placeholder="Search notes, amounts…" value="${esc(view.search)}">
    <select id="hc"><option value="">All categories</option>${S.categories.map(c => `<option value="${esc(c.id)}" ${view.filterCat === c.id ? 'selected' : ''}>${c.icon} ${esc(c.name)}</option>`).join('')}</select></div>`;
  const tot = sum(list.filter(t => t.type === 'expense'));
  html += `<div class="sub" style="margin:0 4px 10px">${list.length} entries · ${money(tot)} spent</div>`;
  html += Object.keys(days).length ? Object.entries(days).map(([d, ts]) => `<div class="day"><div class="day-h"><span>${fmtDay(d)}</span><span class="num">${money(sum(ts.filter(t => t.type === 'expense')))}</span></div><div class="txl">
    ${ts.map(t => { const c = catOf(t.cat); return `<button class="tx" data-id="${t.id}"><div class="ic">${t.type === 'income' ? '💰' : c.icon}</div><div><div class="n">${esc(t.note || (t.type === 'income' ? 'Income' : c.name))}</div><div class="s">${esc(t.type === 'income' ? 'Income' : c.name)}${t.recurId ? ' · 🔁 recurring' : ''}</div></div><div class="a ${t.type === 'income' ? 'inc' : ''}">${t.type === 'income' ? '+' : ''}${money(t.amount)}</div></button>`; }).join('')}</div></div>`).join('')
    : '<div class="empty">No entries for this filter.</div>';
  v.innerHTML = html;
  const hs = $('#hs', v);
  hs.oninput = () => { view.search = hs.value; const pos = hs.selectionStart; renderHistory(v, r); const n = $('#hs', v); n.focus(); n.setSelectionRange(pos, pos); };
  $('#hc', v).onchange = e => { view.filterCat = e.target.value; render(); };
  $$('.tx', v).forEach(el => el.onclick = () => editTx(S.tx.find(t => t.id === el.dataset.id)));
}

let chatAbort = null;
function renderInsights(v, r) {
  const ins = insights(r);
  const ai = S.settings.ai;
  let html = `<div class="card"><h2>Analysis · ${esc(r.label)} <small>on-device rules</small></h2>${ins.map(insHTML).join('') || '<div class="empty">No data yet.</div>'}</div>`;
  html += `<div class="card"><h2>Ask your AI coach <small>local LLM</small></h2>
    <div class="aistat"><span class="dot" id="aidot"></span><span id="aitxt">Checking ${esc(ai.url)} …</span></div>
    <div class="chips" style="margin:10px 0">
      ${['Review my spending this period and give me 3 concrete cuts.', 'Build a realistic monthly budget from my last 3 months.', 'How much can I save per month if I fix my top 2 problem areas?', 'Compare this quarter with last quarter.'].map(p => `<button class="chip qp">${esc(p)}</button>`).join('')}
    </div>
    <div class="chat" id="chat">${S.chat.map(m => `<div class="msg ${m.role}">${m.role === 'assistant' ? md(m.content) : esc(m.content)}</div>`).join('')}</div>
    <div class="chatin"><textarea id="cq" placeholder="Ask about your money…"></textarea><button class="btn pri" id="cs">Send</button></div>
    <div class="btns"><button class="btn sm" id="cclr">Clear chat</button><button class="btn sm" id="csetup">AI setup help</button></div>
  </div>`;
  v.innerHTML = html;
  llmModels().then(ms => { $('#aidot', v)?.classList.add('ok'); const t = $('#aitxt', v); if (t) t.textContent = `Connected · ${ai.model}${ms.length && !ms.includes(ai.model) ? ' (⚠ not in server model list: ' + ms.slice(0, 3).join(', ') + ')' : ''}`; })
    .catch(() => { $('#aidot', v)?.classList.add('no'); const t = $('#aitxt', v); if (t) t.textContent = 'No local LLM reachable — rule-based analysis above still works. Tap "AI setup help".'; });
  const send = async (text) => {
    if (!text.trim()) return;
    if (chatAbort) { chatAbort.abort(); }
    S.chat.push({ role: 'user', content: text.trim() });
    const box = $('#chat', v);
    box.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text.trim())}</div><div class="msg assistant" id="pending"><p class="muted">Thinking… (small models on phones can take 10–60 s)</p></div>`);
    $('#cq', v).value = '';
    const pend = $('#pending', v); pend.scrollIntoView({ block: 'end', behavior: 'smooth' });
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT + '\n\nUSER FINANCIAL DATA:\n' + financeContext(r) }, ...S.chat.slice(-8)];
    chatAbort = new AbortController();
    try {
      const out = await llmChat(msgs, full => { pend.innerHTML = md(full); }, chatAbort.signal);
      S.chat.push({ role: 'assistant', content: out || '(empty response)' });
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'Stopped.' : `Could not reach the local AI at ${ai.url} (${e.message}). See "AI setup help".`;
      pend.innerHTML = `<p>${esc(msg)}</p>`; S.chat.pop();
    }
    pend.removeAttribute('id'); chatAbort = null;
    S.chat = S.chat.slice(-30); save();
  };
  $('#cs', v).onclick = () => send($('#cq', v).value);
  $$('.qp', v).forEach(b => b.onclick = () => send(b.textContent));
  $('#cclr', v).onclick = () => { S.chat = []; save(); render(); };
  $('#csetup', v).onclick = aiHelp;
}

function aiHelp() {
  openSheet(`<h3>Run a free, local AI</h3>
  <p class="sub">The app talks to any OpenAI-compatible server. Nothing leaves your network.</p>
  <b>Option A — on this phone (Termux)</b>
  <pre class="help">1. Install Termux from F-Droid (not Play Store)
2. In Termux:
   pkg update && pkg install ollama
   ollama serve &
   ollama pull qwen2.5:1.5b
3. Settings → AI: URL http://127.0.0.1:11434
   model qwen2.5:1.5b</pre>
  <p class="sub">Needs ~2 GB free RAM. Use qwen2.5:0.5b on weaker phones, qwen2.5:3b or llama3.2:3b on flagship phones.</p>
  <b>Option B — on your PC (same Wi-Fi)</b>
  <pre class="help">Install Ollama (ollama.com), then:
  OLLAMA_HOST=0.0.0.0 ollama serve
  ollama pull qwen2.5:7b
Settings → AI: URL http://&lt;PC-LAN-IP&gt;:11434</pre>
  <p class="sub">llama.cpp's <code>llama-server</code> (port 8080) and LM Studio (port 1234) work too.</p>
  <div class="btns"><button class="btn pri" id="hok">Got it</button></div>`, b => $('#hok', b).onclick = closeSheet);
}

function renderSettings(v) {
  const st = S.settings;
  v.innerHTML = `
  <div class="card"><h2>General</h2>
    <div class="row"><div><label class="f">Currency code</label><input id="scur" value="${esc(st.currency)}" maxlength="3"></div>
    <div><label class="f">Number format</label><select id="sloc">${['en-IN', 'en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'].map(l => `<option ${l === st.locale ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <label class="f">Monthly take-home income (used when no income entries exist)</label><input id="sinc" type="number" inputmode="decimal" value="${st.income || ''}" placeholder="e.g. 85000">
    <div class="row"><div><label class="f">Quarter / year starts</label><select id="sfy"><option value="0" ${+st.fyStart === 0 ? 'selected' : ''}>January (calendar)</option><option value="3" ${+st.fyStart === 3 ? 'selected' : ''}>April (Indian FY)</option></select></div>
    <div><label class="f">Theme</label><select id="sth">${[['auto', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<option value="${k}" ${k === st.theme ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
  </div>
  <details class="card" data-sec="cats"><summary><h2>Categories & monthly budgets <small>${money(budgetTotal())}/mo</small></h2></summary>
    <div class="setcat sub"><span></span><span>Name</span><span>Budget/mo</span><span>Type</span></div>
    ${S.categories.map((c, i) => `<div class="setcat" data-i="${i}"><input class="ci" value="${esc(c.icon)}" maxlength="4" style="text-align:center;padding:7px 2px"><input class="cn" value="${esc(c.name)}"><input class="cb" type="number" inputmode="decimal" value="${c.budget || ''}" placeholder="0"><select class="ck">${['need', 'want', 'save'].map(k => `<option ${k === c.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></div>`).join('')}
    <div class="sub" style="margin-top:6px">Total monthly budget: <b>${money(budgetTotal())}</b>${st.income ? ` · ${Math.round(budgetTotal() / st.income * 100)}% of income` : ''}</div>
    <div class="btns"><button class="btn sm" id="addcat">+ Add category</button><button class="btn sm" id="sugb">Suggest budgets from history</button></div>
  </details>
  <details class="card" data-sec="rec"><summary><h2>Recurring <small>${S.recurring.length} active</small></h2></summary>
    ${S.recurring.length ? S.recurring.map(rc => `<div class="catrow"><div class="ic">${rc.type === 'income' ? '💰' : catOf(rc.cat).icon}</div><div class="nm">${esc(rc.note || catOf(rc.cat).name)} <span class="muted">· day ${rc.day}</span></div><div class="amt">${money(rc.amount)} <button class="btn sm danger delrec" data-id="${rc.id}">✕</button></div></div>`).join('') : '<div class="sub">Rent, EMIs, salary, subscriptions — add them once when adding an entry (tick "Repeat monthly").</div>'}
  </details>
  <details class="card" data-sec="ai"><summary><h2>AI coach <small>local model</small></h2></summary>
    <label class="f">Local server URL (OpenAI-compatible)</label><input id="aurl" value="${esc(st.ai.url)}" placeholder="http://127.0.0.1:11434">
    <div class="row"><div><label class="f">Model</label><input id="amod" value="${esc(st.ai.model)}" list="amods"><datalist id="amods"></datalist></div>
    <div><label class="f">API key (optional)</label><input id="akey" type="password" value="${esc(st.ai.key)}"></div></div>
    <div class="btns"><button class="btn sm" id="atest">Test connection</button><button class="btn sm" id="ahelp">Setup help</button></div>
    <div class="sub" id="ares" style="margin-top:8px"></div>
  </details>
  <details class="card" data-sec="data"><summary><h2>Backup & data <small>${S.tx.length} entries</small></h2></summary>
    <div class="sub">${S.tx.length} entries stored ${Store.native ? 'only on this phone' : 'only in this browser'}. Export regularly — uninstalling the app deletes its data.</div>
    <div class="btns"><button class="btn sm" id="exj">Export backup (JSON)</button><button class="btn sm" id="exc">Export CSV</button></div>
    <div class="btns"><button class="btn sm" id="imj">Import backup</button><button class="btn sm" id="demo">Load demo data</button></div>
    <div class="btns"><button class="btn sm danger" id="undemo">Remove demo data</button><button class="btn sm danger" id="wipe">Delete everything</button></div>
    <input type="file" id="impf" accept=".json,application/json" hidden>
  </details>
  <p class="sub" style="text-align:center">Expense Tracker v${APP_VERSION} · open source · no tracking<br>
    <a href="https://github.com/shashank23088/expense_tracker_app/releases">Updates &amp; source on GitHub</a></p>`;
  $$('details[data-sec]', v).forEach(d => {
    d.open = view.openSecs.has(d.dataset.sec);
    d.ontoggle = () => { d.open ? view.openSecs.add(d.dataset.sec) : view.openSecs.delete(d.dataset.sec); };
  });

  const g = id => $('#' + id, v);
  g('scur').onchange = e => { st.currency = e.target.value.toUpperCase().trim() || 'INR'; resetFmt(); save(); };
  g('sloc').onchange = e => { st.locale = e.target.value; resetFmt(); save(); };
  g('sinc').onchange = e => { st.income = +e.target.value || 0; save(); render(); };
  g('sfy').onchange = e => { st.fyStart = +e.target.value; save(); };
  g('sth').onchange = e => { st.theme = e.target.value; save(); applyTheme(); };
  $$('.setcat[data-i]', v).forEach(row => {
    const c = S.categories[+row.dataset.i];
    $('.ci', row).onchange = e => { c.icon = e.target.value || '📦'; save(); };
    $('.cn', row).onchange = e => { c.name = e.target.value || c.name; save(); };
    $('.cb', row).onchange = e => { c.budget = +e.target.value || 0; save(); render(); };
    $('.ck', row).onchange = e => { c.kind = e.target.value; save(); };
  });
  g('addcat').onclick = () => { S.categories.push({ id: 'c' + uid(), name: 'New category', icon: '🏷️', kind: 'want', budget: 0 }); save(); render(); };
  g('sugb').onclick = () => {
    const ms = lastMonths(4).slice(0, 3).filter(m => m.total > 0);
    if (!ms.length) return toast('Need at least one full month of history.');
    for (const c of S.categories) {
      const avg = ms.reduce((a, m) => a + sum(expIn(m.r).filter(t => t.cat === c.id)), 0) / ms.length;
      if (avg > 0) { const target = c.kind === 'want' ? avg * 0.85 : avg; const p = 10 ** Math.max(0, Math.floor(Math.log10(target)) - 1); c.budget = Math.round(target / p) * p; }
    }
    save(); render(); toast('Budgets set: needs = 3-month avg, wants = avg −15%.');
  };
  $$('.delrec', v).forEach(b => b.onclick = async () => { if (!await ask('Stop this recurring entry? Past entries are kept.', 'Stop repeating')) return; S.recurring = S.recurring.filter(x => x.id !== b.dataset.id); save(); render(); });
  const saveAI = () => { st.ai.url = g('aurl').value.trim(); st.ai.model = g('amod').value.trim(); st.ai.key = g('akey').value; save(); };
  ['aurl', 'amod', 'akey'].forEach(id => g(id).onchange = saveAI);
  g('atest').onclick = async () => {
    saveAI(); g('ares').textContent = 'Testing…';
    try { const ms = await llmModels(); g('ares').innerHTML = `✓ Connected. Models: ${esc(ms.join(', ') || '(none listed)')}`; g('amods').innerHTML = ms.map(m => `<option value="${esc(m)}">`).join(''); if (ms.length && !ms.includes(st.ai.model)) g('ares').innerHTML += `<br>⚠ "${esc(st.ai.model)}" not found — pick one of the above.`; }
    catch (e) { g('ares').textContent = '✕ Not reachable: ' + (e.name === 'AbortError' ? 'timeout' : e.message); }
  };
  g('ahelp').onclick = aiHelp;
  g('exj').onclick = () => exportFile(`expenses-backup-${todayStr()}.json`, 'application/json', JSON.stringify({ ...S, chat: [] }, null, 1));
  g('exc').onclick = () => {
    const rows = [['date', 'type', 'category', 'amount', 'note']].concat([...S.tx].sort((a, b) => a.date.localeCompare(b.date)).map(t => [t.date, t.type, catOf(t.cat).name, t.amount, t.note || '']));
    exportFile(`expenses-${todayStr()}.csv`, 'text/csv', rows.map(r => r.map(x => /[",\n]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n'));
  };
  g('imj').onclick = () => g('impf').click();
  g('impf').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = migrate(JSON.parse(await f.text()));
      if (!data || !Array.isArray(data.tx)) throw new Error('not a backup file');
      e.target.value = '';
      if (!await ask(`Replace all current data with this backup (${data.tx.length} entries)?`, 'Replace')) return;
      S = data; save(); resetFmt(); applyTheme(); render(); toast('Backup restored.');
    } catch (err) { toast('Import failed: ' + err.message); }
  };
  g('demo').onclick = () => { loadDemo(); render(); toast('Demo data added (6 months).'); };
  g('undemo').onclick = () => { const n = S.tx.length; S.tx = S.tx.filter(t => !t.demo); S.recurring = S.recurring.filter(x => !x.demo); save(); render(); toast(`Removed ${n - S.tx.length} demo entries.`); };
  g('wipe').onclick = async () => { if (!await ask(`Delete all ${S.tx.length} entries, budgets and settings? This cannot be undone. Export a backup first.`, 'Delete everything')) return; S = freshState(); save(); resetFmt(); render(); };
}

function exportFile(name, mime, text) {
  if (Store.native) {
    const res = window.AndroidBridge.saveFile(name, mime, text);
    if (res && res.startsWith('ok')) toast('Saved to Downloads/' + name, 3500);
    else { window.AndroidBridge.share(name, text); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------- add / edit ---------------- */
function editTx(t) {
  const isNew = !t;
  // no preselected category: a silent default files entries under the wrong one
  t = t ? { ...t } : { id: uid(), type: 'expense', amount: '', cat: '', date: todayStr(), note: '' };
  // most-used categories (last 90 days) first; the rest behind "More"
  const since = ymd(new Date(Date.now() - 90 * 864e5)), uses = {};
  for (const x of S.tx) if (x.type === 'expense' && x.date >= since) uses[x.cat] = (uses[x.cat] || 0) + 1;
  const ordered = [...S.categories].sort((a, b) => (uses[b.id] || 0) - (uses[a.id] || 0));
  const TOP = 8;
  let showAll = ordered.findIndex(c => c.id === t.cat) >= TOP;
  const catChips = () => (showAll ? ordered : ordered.slice(0, TOP)).map(c => `<button class="chip ${c.id === t.cat ? 'on' : ''}" data-c="${esc(c.id)}">${c.icon} ${esc(c.name)}</button>`).join('')
    + (!showAll && ordered.length > TOP ? `<button class="chip ghost" data-more="1">More…</button>` : '');
  const yday = ymd(new Date(Date.now() - 864e5));
  const shortDay = d => { const x = parseD(d); return `${x.getDate()} ${MONTHS[x.getMonth()]}${x.getFullYear() !== new Date().getFullYear() ? ' ' + x.getFullYear() : ''}`; };
  openSheet(`<h3>${isNew ? 'Add entry' : 'Edit entry'}</h3>
    <div class="seg" style="margin:6px 0 4px"><button data-t="expense" class="${t.type === 'expense' ? 'on' : ''}">Expense</button><button data-t="income" class="${t.type === 'income' ? 'on' : ''}">Income</button></div>
    <input id="ea" class="amount-in num" type="number" inputmode="decimal" step="any" placeholder="${esc(money(0))}" value="${t.amount}">
    <div id="ecw"><label class="f">Category</label><div class="chips" id="ec">${catChips()}</div></div>
    <label class="f">Date</label>
    <div class="chips" id="edc"><button class="chip" data-d="${todayStr()}">Today</button><button class="chip" data-d="${yday}">Yesterday</button>
      <span class="chip datepick" id="edp"><span id="edl"></span><input id="ed" type="date" value="${t.date}" max="${todayStr()}" aria-label="Pick a date"></span></div>
    <label class="f">Note</label><input id="en" value="${esc(t.note)}" placeholder="e.g. Swiggy dinner, Uber to office">
    ${isNew ? `<label class="toggle"><input type="checkbox" id="er"> Repeat monthly on this day (rent, EMI, salary, subscriptions)</label>` : ''}
    <div class="btns">${isNew ? '' : '<button class="btn danger" id="edel">Delete</button>'}<button class="btn" id="ecan">Cancel</button><button class="btn pri" id="esave">Save</button></div>`, b => {
    const ec = $('#ec', b), ecw = $('#ecw', b);
    const syncType = () => { ecw.hidden = t.type === 'income'; $$('.seg button', b).forEach(x => x.classList.toggle('on', x.dataset.t === t.type)); };
    syncType();
    $$('.seg button', b).forEach(x => x.onclick = () => { t.type = x.dataset.t; syncType(); });
    ec.onclick = e => {
      if (e.target.closest('[data-more]')) { showAll = true; ec.innerHTML = catChips(); return; }
      const c = e.target.closest('[data-c]'); if (!c) return;
      t.cat = c.dataset.c; ecw.classList.remove('need'); $$('.chip', ec).forEach(x => x.classList.toggle('on', x === c));
    };
    const ed = $('#ed', b);
    const syncDate = () => {
      const d = ed.value || todayStr(), other = d !== todayStr() && d !== yday;
      $$('#edc [data-d]', b).forEach(x => x.classList.toggle('on', x.dataset.d === d));
      $('#edp', b).classList.toggle('on', other);
      $('#edl', b).textContent = other ? '📅 ' + shortDay(d) : '📅 Other day';
    };
    $$('#edc [data-d]', b).forEach(x => x.onclick = () => { ed.value = x.dataset.d; syncDate(); });
    ed.onchange = syncDate;
    ed.onclick = () => { try { ed.showPicker(); } catch { } };
    syncDate();
    setTimeout(() => $('#ea', b).focus(), 50);
    $('#ecan', b).onclick = closeSheet;
    if (!isNew) $('#edel', b).onclick = async () => { if (!await ask(`Delete ${money(+t.amount)} ${t.type === 'income' ? 'income' : catOf(t.cat).name} entry?`, 'Delete')) return; S.tx = S.tx.filter(x => x.id !== t.id); save(); render(); };
    $('#esave', b).onclick = () => {
      const amt = parseFloat($('#ea', b).value);
      if (!(amt > 0)) { toast('Enter an amount'); $('#ea', b).focus(); return; }
      if (t.type === 'expense' && !t.cat) { toast('Pick a category'); ecw.classList.add('need'); return; }
      t.amount = Math.round(amt * 100) / 100; t.date = $('#ed', b).value || todayStr(); t.note = $('#en', b).value.trim();
      if (t.type === 'income') t.cat = 'income';
      if (isNew) {
        if ($('#er', b)?.checked) {
          const rc = { id: uid(), type: t.type, amount: t.amount, cat: t.cat, day: parseD(t.date).getDate(), note: t.note, start: t.date.slice(0, 7) };
          const d = parseD(t.date); rc.next = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1)).slice(0, 7);
          t.recurId = rc.id; S.recurring.push(rc);
        }
        S.tx.push(t);
      } else S.tx = S.tx.map(x => x.id === t.id ? t : x);
      save(); closeSheet(); render(); toast(isNew ? `Added ${money(t.amount)}` : 'Saved');
    };
  });
}

/* ---------------- demo data ---------------- */
function loadDemo() {
  let seed = 42; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const now = new Date(), push = (d, cat, amount, note, type = 'expense', recurId) => { if (d <= now) S.tx.push({ id: uid(), type, amount: Math.round(amount), cat, date: ymd(d), note, demo: true, ...(recurId ? { recurId } : {}) }); };
  const start = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const fixedBills = [['income', 85000, 'Salary', 1, 'income'], ['housing', 22000, 'Rent', 2], ['emi', 9500, 'Bike EMI', 5], ['utilities', 799, 'Internet', 10], ['subscriptions', 649, 'Netflix', 12], ['subscriptions', 119, 'Spotify', 12], ['savings', 10000, 'SIP', 15]]
    .map(([cat, amount, note, day, type = 'expense']) => ({ id: uid(), type, amount, cat, day, note, start: ymd(start).slice(0, 7), demo: true }));
  // past months are generated below; recurring engine continues from the current month
  for (const rc of fixedBills) rc.next = ymd(new Date(now.getFullYear(), now.getMonth() + (rc.day <= now.getDate() ? 1 : 0), 1)).slice(0, 7);
  S.recurring.push(...fixedBills);
  for (let mo = 5; mo >= 0; mo--) {
    const y = now.getFullYear(), m = now.getMonth() - mo, dim = new Date(y, m + 1, 0).getDate();
    for (const rc of fixedBills) push(new Date(y, m, rc.day), rc.cat, rc.amount, rc.note, rc.type, rc.id);
    push(new Date(y, m, 8), 'utilities', 1800 + rnd() * 900, 'Electricity');
    for (let d = 1; d <= dim; d++) {
      const day = new Date(y, m, d), we = day.getDay() % 6 === 0;
      if (rnd() < 0.55) push(day, 'food', (we ? 450 : 180) + rnd() * (we ? 900 : 300), pick(['Swiggy', 'Zomato', 'Cafe', 'Lunch', 'Chai & snacks']));
      if (rnd() < 0.25) push(day, 'groceries', 300 + rnd() * 1400, pick(['BigBasket', 'Blinkit', 'Local store']));
      if (!we && rnd() < 0.7) push(day, 'transport', 80 + rnd() * 220, pick(['Uber', 'Metro', 'Auto', 'Petrol']));
      if (rnd() < 0.06) push(day, 'shopping', 600 + rnd() * 3000, pick(['Amazon', 'Myntra', 'Mall']));
      if (we && rnd() < 0.35) push(day, 'entertainment', 300 + rnd() * 900, pick(['Movie', 'Bowling', 'Concert']));
      if (rnd() < 0.03) push(day, 'health', 300 + rnd() * 1500, 'Pharmacy');
    }
    if (mo === 2) push(new Date(y, m, 20), 'travel', 14500, 'Goa trip flights');
    if (mo === 0) push(new Date(y, m, Math.min(3, now.getDate())), 'shopping', 7999, 'Headphones');
  }
  save();
}

/* ---------------- wiring ---------------- */
$$('.tabs button').forEach(b => b.onclick = () => { view.tab = b.dataset.tab; if (view.tab !== 'history') view.filterCat = ''; render(); scrollTo(0, 0); });
$$('.seg button[data-kind]').forEach(b => b.onclick = () => { view.kind = b.dataset.kind; render(); });
$('#prevP').onclick = () => { view.anchor = shiftAnchor(view.kind, view.anchor, -1); render(); };
$('#nextP').onclick = () => { view.anchor = shiftAnchor(view.kind, view.anchor, 1); render(); };
$('#fab').onclick = () => editTx(null);
$('.sheet-backdrop').onclick = closeSheet;
// Android back button: close sheet → go home → exit
window.__onSystemTheme = applyTheme; // called by the APK when the system switches light/dark
window.__onBack = () => {
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (view.tab !== 'home') { view.tab = 'home'; render(); return true; }
  return false;
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) { generateRecurring(); render(); } });

applyTheme();
generateRecurring();
render();

