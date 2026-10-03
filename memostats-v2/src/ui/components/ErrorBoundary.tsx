import { Component, type ErrorInfo, type ReactNode } from 'react';
import { log } from '../../logs/logStore';

/** A render error in one screen must never blank the app (and its BLE session) in the car. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log('APP', `Screen crashed: ${error.message}`, { stack: info.componentStack?.slice(0, 600) ?? null }, 'error');
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card">
        <p className="notice notice--error">Ecranul a întâmpinat o eroare: {this.state.error.message}</p>
        <button type="button" className="btn btn--secondary" onClick={() => this.setState({ error: null })}>REÎNCEARCĂ</button>
      </section>
    );
  }
}
