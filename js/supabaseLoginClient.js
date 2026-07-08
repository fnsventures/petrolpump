/**
 * Minimal Supabase client for login.html only (~8 KB bundled).
 * Implements auth + single-table REST queries; session format matches full client.
 */

function projectRefFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host.split(".")[0] || "local";
  } catch {
    return "local";
  }
}

function storageKey(url) {
  return `sb-${projectRefFromUrl(url)}-auth-token`;
}

function readStoredSession(url) {
  try {
    const raw = localStorage.getItem(storageKey(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.access_token && parsed?.user) return parsed;
    if (parsed?.currentSession?.access_token) return parsed.currentSession;
    return null;
  } catch {
    return null;
  }
}

function writeStoredSession(url, session) {
  if (!session) {
    localStorage.removeItem(storageKey(url));
    return;
  }
  localStorage.setItem(storageKey(url), JSON.stringify(session));
}

function authHeaders(key, token) {
  const bearer = token || key;
  return {
    apikey: key,
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
  };
}

function createQueryBuilder(url, key, table, token) {
  const state = { select: "*", filters: [] };

  const builder = {
    select(columns = "*") {
      state.select = columns;
      return builder;
    },
    eq(column, value) {
      state.filters.push({ column, value });
      return builder;
    },
    async maybeSingle() {
      const params = new URLSearchParams({ select: state.select });
      for (const { column, value } of state.filters) {
        params.append(column, `eq.${value}`);
      }
      const res = await fetch(`${url}/rest/v1/${table}?${params}`, {
        headers: { ...authHeaders(key, token), Accept: "application/json" },
      });
      if (!res.ok) {
        let message = res.statusText;
        try {
          const body = await res.json();
          message = body.message || body.error || message;
        } catch {
          /* ignore */
        }
        return { data: null, error: { message } };
      }
      const rows = await res.json();
      return { data: rows?.[0] ?? null, error: null };
    },
  };

  return builder;
}

function createAuthClient(url, key) {
  const auth = {
    async getSession() {
      const stored = readStoredSession(url);
      if (!stored) return { data: { session: null }, error: null };
      return {
        data: {
          session: {
            access_token: stored.access_token,
            refresh_token: stored.refresh_token,
            expires_at: stored.expires_at,
            user: stored.user,
          },
        },
        error: null,
      };
    },

    async signInWithPassword({ email, password }) {
      try {
        const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: authHeaders(key),
          body: JSON.stringify({ email, password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return { data: { session: null, user: null }, error: { message: body.error_description || body.msg || body.error || "Sign in failed" } };
        }
        const session = {
          access_token: body.access_token,
          refresh_token: body.refresh_token,
          expires_at: body.expires_at,
          expires_in: body.expires_in,
          token_type: body.token_type,
          user: body.user,
        };
        writeStoredSession(url, session);
        return { data: { session, user: body.user }, error: null };
      } catch (err) {
        return { data: { session: null, user: null }, error: { message: err.message || "Network error" } };
      }
    },

    async resetPasswordForEmail(email, { redirectTo } = {}) {
      try {
        const res = await fetch(`${url}/auth/v1/recover`, {
          method: "POST",
          headers: authHeaders(key),
          body: JSON.stringify({ email, redirect_to: redirectTo }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          return { data: null, error: { message: body.error_description || body.msg || body.error || "Request failed" } };
        }
        return { data: {}, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message || "Network error" } };
      }
    },

    async signOut() {
      const stored = readStoredSession(url);
      if (stored?.access_token) {
        try {
          await fetch(`${url}/auth/v1/logout`, {
            method: "POST",
            headers: authHeaders(key, stored.access_token),
          });
        } catch {
          /* ignore */
        }
      }
      writeStoredSession(url, null);
      return { error: null };
    },
  };

  return auth;
}

export function createClient(url, key) {
  const auth = createAuthClient(url, key);

  return {
    auth,
    supabaseUrl: url,
    supabaseKey: key,
    from(table) {
      const stored = readStoredSession(url);
      return createQueryBuilder(url, key, table, stored?.access_token);
    },
  };
}

