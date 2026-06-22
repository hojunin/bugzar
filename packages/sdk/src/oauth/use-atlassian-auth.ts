// React wrapper around the Atlassian OAuth core: tracks connection state, drives
// the popup connect, and hands the drawer a fresh access token on demand.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Endpoint, resolveEndpoint } from '../upload';
import {
  type AtlassianSession,
  clearSession,
  connectAtlassian,
  getValidAccessToken,
  loadSession,
  type WorkerTarget,
} from './atlassian';

export type AuthState =
  | { kind: 'loading' }
  | { kind: 'not-connected' }
  | { kind: 'authenticated'; session: AtlassianSession };

export interface UseAtlassianAuth {
  state: AuthState;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** A valid access token (refreshes if needed); null means re-auth required. */
  getToken: () => Promise<string | null>;
}

export function useAtlassianAuth(
  endpoint: Endpoint | undefined,
  clientId: string | undefined,
): UseAtlassianAuth {
  const [state, setState] = useState<AuthState>({ kind: 'loading' });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const target = useMemo<WorkerTarget | null>(
    () => (endpoint ? resolveEndpoint(endpoint) : null),
    [endpoint],
  );

  useEffect(() => {
    mounted.current = true;
    const session = loadSession();
    setState(session ? { kind: 'authenticated', session } : { kind: 'not-connected' });
    return () => {
      mounted.current = false;
    };
  }, []);

  const connect = useCallback(async () => {
    if (!target || !clientId || connecting) return;
    setConnecting(true);
    setError(null);
    const r = await connectAtlassian(target, clientId);
    if (!mounted.current) return;
    setConnecting(false);
    if (r.ok) setState({ kind: 'authenticated', session: r.session });
    else setError(r.error);
  }, [target, clientId, connecting]);

  const disconnect = useCallback(() => {
    clearSession();
    setError(null);
    setState({ kind: 'not-connected' });
  }, []);

  const getToken = useCallback(async () => {
    if (!target) return null;
    const token = await getValidAccessToken(target);
    if (!token && mounted.current) {
      clearSession();
      setState({ kind: 'not-connected' });
    }
    return token;
  }, [target]);

  return { state, connecting, error, connect, disconnect, getToken };
}
