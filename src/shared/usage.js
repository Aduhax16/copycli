// Plan quota, never context-window fullness or a token-count estimate.
export const remainingPercent = (windows = []) => {
  const used = windows.map((w) => w.usedPercent).filter(Number.isFinite);
  return used.length ? Math.round(100 - Math.min(100, Math.max(0, ...used))) : null;
};
export const quotaName = (w) => w.label || (w.minutes >= 10080 ? 'Weekly' : w.minutes >= 60 ? `${Math.round(w.minutes / 60)} h` : w.minutes ? `${w.minutes} min` : 'Plan');
export const quotaTooltip = (a) => a.usage?.length
  ? a.usage.map((w) => `${quotaName(w)}: ${remainingPercent([w])}% left${w.resetsAt ? ` · resets ${new Date(w.resetsAt * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`).join('\n') + (a.usageUpdatedAt ? `\nChecked ${new Date(a.usageUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '')
  : 'Remaining plan quota is not available from this agent yet.';
