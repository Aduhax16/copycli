// Quota responses are provider data; missing values must not become 0% or 100%.
const percent = (n) => Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
const reset = (v) => {
  const t = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) / 1000 : null;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};
export function claudeUsage(data) {
  const limits = data?.rate_limits || {};
  return Object.entries(limits).flatMap(([key, value]) => {
    if (!/^five_hour$|^seven_day(?:_(?:opus|sonnet|oauth_apps|cowork))?$/.test(key)) return [];
    const used = percent(value?.utilization ?? value?.used_percentage);
    if (used === null) return [];
    const scope = /_(opus|sonnet)$/.exec(key)?.[1];
    // Other apps have their own pools, not Claude Code's allowance.
    if (key.endsWith('_oauth_apps') || key.endsWith('_cowork')) return [];
    const minutes = key === 'five_hour' ? 300 : 10080;
    return [{ id: key, usedPercent: used, resetsAt: reset(value.resets_at), minutes, label: `${minutes === 300 ? '5 h' : 'Weekly'}${scope ? ` · ${scope}` : ''}`, ...(scope ? { scope } : {}) }];
  });
}
export function claudeRateUsage(rate) {
  if (!Number.isFinite(rate?.utilization)) return [];
  const kind = rate.rateLimitType;
  if (!/^five_hour$|^seven_day(?:_(?:opus|sonnet))?$/.test(kind || '')) return [];
  const scope = /_(opus|sonnet)$/.exec(kind)?.[1];
  return [{ id: kind, usedPercent: percent(rate.utilization <= 1 ? rate.utilization * 100 : rate.utilization), resetsAt: reset(rate.resetsAt), minutes: kind === 'five_hour' ? 300 : 10080, ...(scope ? { scope } : {}) }];
}
export function agyUsage(data) {
  return (data?.groups || []).flatMap((group) => (group.buckets || []).flatMap((bucket) => {
    if (!Number.isFinite(bucket.remaining_fraction) || bucket.disabled) return [];
    const minutes = bucket.window === 'weekly' ? 10080 : bucket.window === '5h' ? 300 : null;
    if (!minutes) return [];
    const scope = bucket.id?.startsWith('gemini-') ? 'gemini' : bucket.id?.startsWith('3p-') ? 'third-party' : undefined;
    return [{ id: bucket.id || `${group.name}:${bucket.window}`, usedPercent: percent((1 - bucket.remaining_fraction) * 100), resetsAt: reset(bucket.reset_time), minutes, label: `${group.name} · ${minutes === 300 ? '5 h' : 'Weekly'}`, ...(scope ? { scope } : {}) }];
  }));
}
