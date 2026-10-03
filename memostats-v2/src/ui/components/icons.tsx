// Stroke icons for the bottom navigation (24×24, currentColor).
const common = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const IconLive = () => <svg {...common}><path d="M4 16a8 8 0 1 1 16 0" /><path d="M12 16l4-5" /><circle cx="12" cy="16" r="1.2" /></svg>;
export const IconPerformance = () => <svg {...common}><circle cx="12" cy="13" r="7.5" /><path d="M12 13V9" /><path d="M10 2.5h4" /><path d="M18.5 6.5l1.5-1.5" /></svg>;
export const IconDiagnostics = () => <svg {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>;
export const IconCapture = () => <svg {...common}><path d="M3 12h3l2.5-6 4 12 3-9 2 3H21" /></svg>;
export const IconSettings = () => <svg {...common}><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></svg>;
