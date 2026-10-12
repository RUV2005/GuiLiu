import { apiCurrency, planDecimal, planResult, resultList } from './plans-model.js';

function units(value, currency) {
  const [whole, fraction = ''] = planDecimal(value, currency).split('.');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}
function amount(value, currency) {
  return String(value / 100n) + (apiCurrency(currency) === 'JPY' ? '' : '.' + String(value % 100n).padStart(2, '0'));
}
export function allocationSnapshot(plan, entries) {
  const totals = Object.fromEntries(plan.account_numbers.map(id => [id, 0n]));
  const seen = new Set();
  for (const row of entries) {
    if (!row.id || seen.has(row.id) || !['contribution', 'withdrawal', 'spending'].includes(row.type) ||
      apiCurrency(row.currency) !== apiCurrency(plan.currency)) throw new Error('allocationIncomplete');
    seen.add(row.id);
    const value = units(row.amount, plan.currency);
    if (row.account_number == null) continue;
    if (!Number.isSafeInteger(row.account_number)) throw new Error('allocationIncomplete');
    if (!(row.account_number in totals)) continue;
    totals[row.account_number] += row.type === 'contribution' ? value : -value;
  }
  // Opening funds and unassigned entries never implicitly belong to an account.
  if (Object.values(totals).some(value => value < 0n)) throw new Error('allocationIncomplete');
  return { id: plan.id, version: plan.version, amounts: Object.fromEntries(Object.entries(totals).map(([id, value]) => [id, planDecimal(amount(value, plan.currency), plan.currency)])) };
}
export async function loadAllocations(api, plan, options = {}) {
  let total, rows = [];
  do {
    options.signal?.throwIfAborted();
    const page = resultList(await api.entries(plan.id, { limit: 100, offset: rows.length }, options));
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.total > 20000 ||
      total !== undefined && total !== page.total || page.items.length > 100 ||
      rows.length + page.items.length > page.total || !page.items.length && rows.length < page.total) throw new Error('allocationIncomplete');
    total = page.total;
    rows.push(...page.items);
  } while (rows.length < total);
  const latest = planResult(await api.get(plan.id, options));
  if (latest.id !== plan.id || latest.version !== plan.version) throw new Error('allocationChanged');
  return allocationSnapshot(plan, rows);
}
export function allocationScale(plan, value) {
  if (plan.target_amount == null || value == null) return null;
  const target = units(plan.target_amount, plan.currency), current = units(value, plan.currency);
  if (!target) return null;
  const percent = Number((current * 10000n + target / 2n) / target) / 100;
  return { percent, max: Math.max(100, Math.ceil(percent)) };
}
export function allocationPreview(plan, snapshot, account, percent) {
  if (snapshot?.id !== plan.id || snapshot.version !== plan.version || !plan.account_numbers.includes(account)) throw new Error('allocationChanged');
  const from = snapshot.amounts[account], scale = allocationScale(plan, from), value = Number(percent);
  if (!scale || !Number.isFinite(value) || value < 0 || value > scale.max) throw new Error('invalidAmount');
  const target = units(plan.target_amount, plan.currency), ticks = BigInt(Math.round(value * 100));
  const quantum = apiCurrency(plan.currency) === 'JPY' ? 100n : 1n;
  const next = (target * ticks + 5000n * quantum) / (10000n * quantum) * quantum;
  return { id: plan.id, version: plan.version, account, from, amount: planDecimal(amount(next, plan.currency), plan.currency), percent: value };
}
export function allocationDelta(plan, draft) {
  const difference = units(draft.amount, plan.currency) - units(draft.from, plan.currency);
  if (!difference) return null;
  return { type: difference > 0n ? 'contribution' : 'withdrawal', amount: amount(difference > 0n ? difference : -difference, plan.currency), account_number: String(draft.account) };
}
