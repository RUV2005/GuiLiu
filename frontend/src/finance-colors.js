export function financeTone(value, meaning = 'balance') {
  if (!['balance', 'liability', 'expense-change', 'amount'].includes(meaning)) return null;
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return 'neutral';
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return 'neutral';
  if (meaning === 'amount') return number < 0 ? 'negative' : null;
  const signed = meaning === 'liability' ? -Math.abs(number) : meaning === 'expense-change' ? -number : number;
  return signed > 0 ? 'positive' : 'negative';
}

export function financeAttr(value, meaning = 'balance') {
  const tone = financeTone(value, meaning);
  return tone ? ' data-finance-tone="' + tone + '"' : '';
}

// Only explicit data keys convey meaning; chart titles and translated labels do not.
export function financeColumnMeaning(column) {
  if (!column || !['money', 'number'].includes(column.type)) return null;
  if (['balance', 'net', 'net_assets', 'net_worth', 'surplus', 'budget_remaining', 'profit', 'pnl', 'gain_loss', 'change_percent'].includes(column.key)) return 'balance';
  if (['debt', 'liabilities', 'liability'].includes(column.key)) return 'liability';
  if (['expense_change', 'spending_change'].includes(column.key)) return 'expense-change';
  return column.type === 'money' ? 'amount' : null;
}

export function applyFinanceColors(reversed, root = globalThis.document?.documentElement) {
  if (root) root.dataset.financeColors = reversed === true ? 'reversed' : 'standard';
}
