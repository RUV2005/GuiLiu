// Presentation is optional. Invalid hints must never hide otherwise valid evidence.
export function normalizeCanvasReport(value, charts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = (item, max) => item === undefined || typeof item === 'string' && item.trim().length > 0 && item.length <= max;
  if (!text(value.title, 160) || !text(value.summary, 800)) return null;
  const sections = value.sections ?? [];
  if (!Array.isArray(sections) || sections.length > 8) return null;
  const ids = new Set();
  for (const section of sections) {
    if (!section || typeof section !== 'object' || !text(section.id, 120) || !section.id || ids.has(section.id)
      || !text(section.title, 160) || !section.title || !text(section.summary, 500)
      || !['auto', 'full', 'paired'].includes(section.layout ?? 'auto')
      || !Array.isArray(section.chart_ids) || !section.chart_ids.length
      || !section.chart_ids.every(id => typeof id === 'string')) return null;
    ids.add(section.id);
  }
  // Sections partition the existing reading order; they cannot drop or duplicate a chart.
  const references = sections.flatMap(section => section.chart_ids);
  if (sections.length && (references.length !== charts.length || references.some((id, i) => id !== charts[i].id))) return null;
  if (!value.title && !value.summary && !sections.length) return null;
  return {
    ...(value.title ? { title: value.title.trim() } : {}),
    ...(value.summary ? { summary: value.summary.trim() } : {}),
    sections: sections.map(section => ({
      id: section.id, title: section.title.trim(),
      ...(section.summary ? { summary: section.summary.trim() } : {}),
      layout: section.layout ?? 'auto', chart_ids: [...section.chart_ids],
    })),
  };
}
