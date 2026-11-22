import { useEffect, useState } from 'react';

type HealthPayload =
  | { ok: true; db: 'ok'; redis: 'ok'; requestId: string }
  | { ok: false; db: 'ok' | 'down'; redis: 'ok' | 'down'; requestId: string };

type HealthState =
  | { status: 'loading' }
  | { status: 'responded'; payload: HealthPayload }
  | { status: 'unavailable' };

function isHealthPayload(value: unknown): value is HealthPayload {
  if (typeof value !== 'object' || value === null) return false;

  const payload = value as Record<string, unknown>;
  const dbOk = payload.db === 'ok' || payload.db === 'down';
  const redisOk = payload.redis === 'ok' || payload.redis === 'down';
  return (
    typeof payload.requestId === 'string' &&
    dbOk &&
    redisOk &&
    ((payload.ok === true && payload.db === 'ok' && payload.redis === 'ok') ||
      payload.ok === false)
  );
}

export function HealthStatus() {
  const [health, setHealth] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function loadHealth() {
      try {
        const response = await fetch('/api/health', { signal: controller.signal });
        const body: unknown = await response.json();

        if (!isHealthPayload(body)) {
          throw new Error('Invalid health response');
        }

        setHealth({ status: 'responded', payload: body });
      } catch {
        if (!controller.signal.aborted) setHealth({ status: 'unavailable' });
      }
    }

    void loadHealth();
    return () => controller.abort();
  }, []);

  const healthy = health.status === 'responded' && health.payload.ok;
  const label = health.status === 'loading'
    ? 'Checking…'
    : health.status === 'unavailable'
      ? 'Unavailable'
      : healthy
        ? 'OK'
        : health.payload.db === 'down'
          ? 'Database down'
          : 'Redis down';
  const payload = health.status === 'responded' ? health.payload : null;

  return (
    <section className={`health-status ${healthy ? 'is-healthy' : ''}`} aria-label="Auction API health" aria-live="polite">
      <span className="health-status-heading">System health</span>
      <span className={`health-status-result ${healthy ? 'is-healthy' : ''}`}>
        <span className="health-status-dot" aria-hidden="true" />
        <strong>{label}</strong>
      </span>
      <code>{payload ? JSON.stringify(payload) : '{"ok":null}'}</code>
    </section>
  );
}
