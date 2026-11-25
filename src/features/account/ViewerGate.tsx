import { activateRecoveryAccount, clearRecovery, recoveryAccount } from '../recovery/storage';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { accountKey, accountSchema } from '../../contracts/account';
import { useAccountBoundary } from './useAccountBoundary';
import { ViewerVerification } from './ViewerVerification';
export const DocumentIdentity = createContext<RefObject<string | null | undefined>>({
  current: undefined,
});
export function ViewerGate({
  initial,
  children,
  pendingContent,
}: {
  initial?: string | null;
  children: (userId: string | null) => ReactNode;
  pendingContent?: ReactNode;
}) {
  const client = useQueryClient(),
    identity = useContext(DocumentIdentity);
  const [userId, setUserId] = useState(initial);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    if (initial !== undefined && identity.current === undefined) identity.current = initial;
    const controller = new AbortController();
    const previousOwner = recoveryAccount();
    // Lock before paint and restart the check if Suspense reconnects the route.
    setChecking(true);
    setError(false);
    void fetch('/api/v1/me', { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok && r.status !== 401) throw new Error('identity unavailable');
        const account = r.status === 401 ? { user: null } : accountSchema.parse(await r.json());
        if (controller.signal.aborted) return;
        const id = account.user?.id ?? null;
        if (identity.current !== undefined && identity.current !== id) {
          clearRecovery(identity.current);
          void client.cancelQueries({ queryKey: ['private'] });
          client.removeQueries({ queryKey: ['private'] });
          window.location.reload();
          return;
        }
        if (!activateRecoveryAccount(id, previousOwner)) {
          setAttempt((value) => value + 1);
          return;
        }
        identity.current = id;
        client.setQueryData(accountKey(id), account);
        setUserId(id);
        setChecking(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [initial, client, identity, attempt]);
  useEffect(() => {
    if (!error) return;
    const retry = () => setAttempt((value) => value + 1);
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [error]);
  if (userId === undefined)
    return (
      <>
        {pendingContent}
        <div role="status">
          {error ? '계정을 확인하지 못했습니다.' : '계정을 확인하는 중…'}
          {error ? <button onClick={() => setAttempt((x) => x + 1)}>계정 다시 확인</button> : null}
        </div>
      </>
    );
  return (
    <ViewerVerification.Provider value={!checking}>
      {error ? (
        <p role="alert">
          계정을 확인하지 못했습니다.{' '}
          <button onClick={() => setAttempt((value) => value + 1)}>계정 조회 다시 시도</button>
        </p>
      ) : null}
      {children(userId)}
    </ViewerVerification.Provider>
  );
}
export function AccountBoundary({
  userId,
  children,
}: {
  userId: string | null;
  children: (ready: boolean) => ReactNode;
}) {
  return children(useAccountBoundary(userId));
}
