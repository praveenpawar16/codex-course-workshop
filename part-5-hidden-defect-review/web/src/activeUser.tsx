import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import type { DemoUser } from './types';

const STORAGE_KEY = 'auction-house-active-user';

type ActiveUserContextValue = {
  users: DemoUser[];
  activeUser: DemoUser | null;
  setActiveUserId: (id: string) => void;
  loading: boolean;
  error: string | null;
};

const ActiveUserContext = createContext<ActiveUserContextValue | null>(null);

function pickRandomUserId(users: DemoUser[]): string | null {
  if (users.length === 0) return null;
  const index = Math.floor(Math.random() * users.length);
  return users[index]?.id ?? null;
}

export function ActiveUserProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [activeUserId, setActiveUserIdState] = useState<string | null>(() =>
    window.sessionStorage.getItem(STORAGE_KEY)
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const response = await fetch('/api/users', { signal: controller.signal });
          if (!response.ok) throw new Error('Could not load users');
          const body = (await response.json()) as { users: DemoUser[] };
          setUsers(body.users);
          setActiveUserIdState((current) => {
            if (current && body.users.some((user) => user.id === current)) return current;
            const stored = window.sessionStorage.getItem(STORAGE_KEY);
            if (stored && body.users.some((user) => user.id === stored)) return stored;
            return pickRandomUserId(body.users);
          });
          setError(null);
          setLoading(false);
          return;
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          lastError = err;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      void lastError;
      setError('Could not load demo users');
      setLoading(false);
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (activeUserId) window.sessionStorage.setItem(STORAGE_KEY, activeUserId);
  }, [activeUserId]);

  const activeUser = users.find((user) => user.id === activeUserId) ?? null;

  return (
    <ActiveUserContext.Provider
      value={{
        users,
        activeUser,
        setActiveUserId: (id) => {
          // Write storage synchronously so a navigation right after switching
          // does not remount with a stale or random Active User.
          window.sessionStorage.setItem(STORAGE_KEY, id);
          setActiveUserIdState(id);
        },
        loading,
        error,
      }}
    >
      {children}
    </ActiveUserContext.Provider>
  );
}

export function useActiveUser() {
  const value = useContext(ActiveUserContext);
  if (!value) throw new Error('useActiveUser must be used within ActiveUserProvider');
  return value;
}
