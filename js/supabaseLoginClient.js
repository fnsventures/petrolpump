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

function userFromAccessToken(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const json = JSON.parse(new TextDecoder().decode(bytes));
    if (!json || typeof json !== "object") return null;
    return {
      id: json.sub || "",
      email: json.email || null,
      role: json.role || null,
      aud: json.aud || null,
      user_metadata: json.user_metadata || {},
    };
  } catch {
    return null;
  }
}

/** Recovery links land on login.html with the session in the URL hash. Keep it for getSession. */
function adoptRecoveryHash(url) {
  if (typeof window === "undefined") return;
  let hash;
  try {
    hash = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
  } catch {
    return;
  }
  if (hash.get("type") === "recovery") window.__passwordRecovery = true;
  const accessToken = hash.get("access_token");
  if (hash.get("type") !== "recovery" || !accessToken) return;
  const expiresAt = Number(hash.get("expires_at"));
  const expiresIn = Number(hash.get("expires_in"));
  writeStoredSession(url, {
    access_token: accessToken,
    refresh_token: hash.get("refresh_token") || "",
    expires_at: Number.isFinite(expiresAt) ? expiresAt : undefined,
    expires_in: Number.isFinite(expiresIn) ? expiresIn : undefined,
    token_type: hash.get("token_type") || "bearer",
    user: userFromAccessToken(accessToken) || { id: "recovery" },
  });
  try {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search || ""}`);
  } catch {
    /* ignore */
  }
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
      adoptRecoveryHash(url);
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

    async updateUser({ password } = {}) {
      const stored = readStoredSession(url);
      if (!stored?.access_token) {
        return {
          data: { user: null },
          error: { message: "This reset link is invalid or has expired. Request a new one from the sign-in page." },
        };
      }
      try {
        const res = await fetch(`${url}/auth/v1/user`, {
          method: "PUT",
          headers: authHeaders(key, stored.access_token),
          body: JSON.stringify({ password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          return {
            data: { user: null },
            error: {
              message: body.error_description || body.msg || body.message || body.error || "Could not set the new password.",
            },
          };
        }
        if (body?.id) writeStoredSession(url, { ...stored, user: body });
        return { data: { user: body }, error: null };
      } catch (err) {
        return { data: { user: null }, error: { message: err.message || "Network error" } };
      }
    },

    onAuthStateChange(callback) {
      try {
        if (window.__passwordRecovery && typeof callback === "function") callback("PASSWORD_RECOVERY", null);
      } catch {
        /* a listener must not break sign-in */
      }
      return { data: { subscription: { unsubscribe() {} } } };
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

