import { type ReactNode, useState } from 'react';
import { captureStore } from '../capture/captureStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { IconCapture, IconDiagnostics, IconLive, IconPerformance, IconSettings } from './components/icons';
import { CaptureScreen } from './screens/CaptureScreen';
import { ConnectionBadge } from './screens/ConnectionPanel';
import { DiagnosticsScreen } from './screens/DiagnosticsScreen';
import { LiveScreen } from './screens/LiveScreen';
import { PerformanceScreen } from './screens/PerformanceScreen';
import { SettingsScreen } from './screens/SettingsScreen';

// V1 navigation: DATE LIVE · PERFORMANȚĂ · DIAGNOZĂ · CAPTURĂ · SETĂRI (developer tools inside SETĂRI).
const TABS: { id: string; label: string; icon: ReactNode; screen: () => ReactNode }[] = [
  { id: 'live', label: 'DATE LIVE', icon: <IconLive />, screen: () => <LiveScreen /> },
  { id: 'perf', label: 'PERFORMANȚĂ', icon: <IconPerformance />, screen: () => <PerformanceScreen /> },
  { id: 'diag', label: 'DIAGNOZĂ', icon: <IconDiagnostics />, screen: () => <DiagnosticsScreen /> },
  { id: 'capture', label: 'CAPTURĂ', icon: <IconCapture />, screen: () => <CaptureScreen /> },
  { id: 'settings', label: 'SETĂRI', icon: <IconSettings />, screen: () => <SettingsScreen /> },
];

export function App() {
  const [tab, setTab] = useState('live');
  const active = TABS.find(t => t.id === tab) ?? TABS[0];
  const capturing = captureStore.use().status === 'CAPTURING';

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">M</span>
          <div>
            <p className="eyebrow">W176 · A200</p>
            <p className="brand__name">MemoStats</p>
          </div>
        </div>
        <ConnectionBadge />
      </header>

      {capturing && <p className="notice notice--warn" role="status">● Captură pasivă activă — MemoStats nu transmite nimic</p>}

      <main key={active?.id}><ErrorBoundary>{active?.screen()}</ErrorBoundary></main>

      <nav className="bottomnav" aria-label="Navigare principală">
        {TABS.map(item => (
          <button
            key={item.id}
            type="button"
            className={`bottomnav__item${tab === item.id ? ' bottomnav__item--on' : ''}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            {item.icon}
            <span className="bottomnav__label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
