import { useActiveUser } from '../activeUser';

export function UserSwitcher() {
  const { users, activeUser, setActiveUserId, loading, error } = useActiveUser();

  if (loading) {
    return (
      <label className="user-switcher">
        <span>Active user</span>
        <select disabled aria-label="Active demo user">
          <option>Loading…</option>
        </select>
      </label>
    );
  }

  if (error || users.length === 0) {
    return <p className="user-switcher-error">{error ?? 'No demo users'}</p>;
  }

  return (
    <label className="user-switcher">
      <span>Active user</span>
      <select
        aria-label="Active demo user"
        value={activeUser?.id ?? ''}
        onChange={(event) => setActiveUserId(event.target.value)}
      >
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.displayName} (@{user.handle})
          </option>
        ))}
      </select>
    </label>
  );
}
