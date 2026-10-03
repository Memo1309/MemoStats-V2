import { useEffect, useState } from 'react';
import { loadW176Db } from './db';
import type { W176Db } from './types';

export interface W176DbState {
  db: W176Db | null;
  loading: boolean;
  error: string | null;
}

/** Lazily loads the immutable W176 DB once and shares it across the coding/explorer screens. */
export function useW176Db(): W176DbState {
  const [state, setState] = useState<W176DbState>({ db: null, loading: true, error: null });
  useEffect(() => {
    let alive = true;
    loadW176Db().then(
      db => alive && setState({ db, loading: false, error: null }),
      error => alive && setState({ db: null, loading: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => { alive = false; };
  }, []);
  return state;
}
