import { useEffect, useState } from 'react';
import { captureStore } from '../capture/captureStore';
import { useAppState } from '../state/appState';

/** performance.now(), refreshed on an interval — drives freshness and elapsed-time displays. */
export function useNow(intervalMs = 500): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Vehicle TX allowed: connected and no passive capture listening (actions refuse it too). */
export function useCanTransmit(): boolean {
  const { connection } = useAppState();
  return connection === 'connected' && captureStore.use().status !== 'CAPTURING';
}
