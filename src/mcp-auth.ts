import { createHmac, timingSafeEqual } from "crypto";
import type { Response, Request } from "express";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

const AUTH_CODE_TTL = 5 * 60;               // 5 minutes
const ACCESS_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const REFRESH_TOKEN_TTL = 90 * 24 * 60 * 60; // 90 days

function secret(): string {
  const s = process.env.QUALIA_API_KEY;
  if (!s) throw new Error("QUALIA_API_KEY not set");
  return s;
}

// ─── JWT helpers ──────────────────────────────────────────────────────────────

function signJwt(payload: Record<string, unknown>, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

function verifyJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const [h, p, sig] = parts;
  const expected = createHmac("sha256", secret()).update(`${h}.${p}`).digest("base64url");
  const expBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expBuf.length !== sigBuf.length || !timingSafeEqual(expBuf, sigBuf)) throw new Error("Invalid JWT signature");
  const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>;
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) throw new Error("JWT expired");
  return payload;
}

// ─── Client store (stateless — client_id encodes signed client metadata) ─────

function encodeClientId(data: Omit<OAuthClientInformationFull, "client_id">): string {
  const encoded = Buffer.from(JSON.stringify(data)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function decodeClientId(clientId: string): OAuthClientInformationFull | undefined {
  const dot = clientId.lastIndexOf(".");
  if (dot === -1) return undefined;
  const encoded = clientId.slice(0, dot);
  const sig = clientId.slice(dot + 1);
  const expected = createHmac("sha256", secret()).update(encoded).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  try {
    const data = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Omit<OAuthClientInformationFull, "client_id">;
    return { ...data, client_id: clientId };
  } catch {
    return undefined;
  }
}

// Static pre-registered client (set MCP_CLIENT_ID + MCP_CLIENT_SECRET + MCP_REDIRECT_URI in env).
// Takes priority over dynamic registration so the user can paste these values into OAuth UI fields.
function staticClient(): OAuthClientInformationFull | undefined {
  const id = process.env.MCP_CLIENT_ID;
  if (!id) return undefined;
  return {
    client_id: id,
    client_secret: process.env.MCP_CLIENT_SECRET,
    redirect_uris: [process.env.MCP_REDIRECT_URI ?? "https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: process.env.MCP_CLIENT_SECRET ? "client_secret_post" : "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: 0,
  };
}

const clientsStore: OAuthRegisteredClientsStore = {
  getClient(clientId: string) {
    const s = staticClient();
    if (s && clientId === s.client_id) return s;
    return decodeClientId(clientId);
  },
  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const data: Omit<OAuthClientInformationFull, "client_id"> = {
      ...client,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    return { ...data, client_id: encodeClientId(data) };
  },
};

// ─── Login form ───────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function loginForm(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Qualia Access — Authorize</title>
  <style>
    body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
    .card{background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.12);padding:2rem;width:320px}
    h1{font-size:1.25rem;margin:0 0 1.5rem}
    label{display:block;font-size:.875rem;margin-bottom:.25rem;color:#555}
    input[type=password]{width:100%;box-sizing:border-box;padding:.5rem .75rem;border:1px solid #ddd;border-radius:4px;font-size:1rem;margin-bottom:1rem}
    button{width:100%;padding:.6rem;background:#0066cc;color:#fff;border:none;border-radius:4px;font-size:1rem;cursor:pointer}
    button:hover{background:#0052a3}
    .error{color:#c0392b;font-size:.875rem;margin-bottom:1rem}
  </style>
</head>
<body>
  <div class="card">
    <h1>Qualia Access</h1>
    ${p.error ? `<div class="error">${esc(p.error)}</div>` : ""}
    <form method="POST" action="/oauth/login">
      <input type="hidden" name="client_id" value="${esc(p.clientId)}">
      <input type="hidden" name="redirect_uri" value="${esc(p.redirectUri)}">
      <input type="hidden" name="state" value="${esc(p.state)}">
      <input type="hidden" name="code_challenge" value="${esc(p.codeChallenge)}">
      <input type="hidden" name="scopes" value="${esc(p.scopes)}">
      <label for="pw">API Key</label>
      <input type="password" id="pw" name="password" autofocus placeholder="Enter your API key">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

// ─── OAuth provider ───────────────────────────────────────────────────────────

export function createOAuthProvider(): OAuthServerProvider {
  return {
    get clientsStore(): OAuthRegisteredClientsStore { return clientsStore; },

    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
      res.status(200).type("html").send(loginForm({
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state ?? "",
        codeChallenge: params.codeChallenge,
        scopes: (params.scopes ?? []).join(" "),
      }));
    },

    async challengeForAuthorizationCode(_client: OAuthClientInformationFull, code: string): Promise<string> {
      const payload = verifyJwt(code);
      if (payload["type"] !== "code") throw new Error("Not an auth code");
      return payload["code_challenge"] as string;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      code: string,
      _codeVerifier?: string,
      redirectUri?: string,
    ): Promise<OAuthTokens> {
      const payload = verifyJwt(code);
      if (payload["type"] !== "code") throw new Error("Not an auth code");
      if (payload["client_id"] !== client.client_id) throw new Error("Client mismatch");
      if (redirectUri && payload["redirect_uri"] !== redirectUri) throw new Error("redirect_uri mismatch");

      const scope = (payload["scopes"] as string | undefined) ?? "mcp";
      return {
        access_token: signJwt({ type: "access", client_id: client.client_id, scope }, ACCESS_TOKEN_TTL),
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL,
        scope,
        refresh_token: signJwt({ type: "refresh", client_id: client.client_id, scope }, REFRESH_TOKEN_TTL),
      };
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[],
    ): Promise<OAuthTokens> {
      const payload = verifyJwt(refreshToken);
      if (payload["type"] !== "refresh") throw new Error("Not a refresh token");
      if (payload["client_id"] !== client.client_id) throw new Error("Client mismatch");

      const scope = scopes?.join(" ") ?? (payload["scope"] as string | undefined) ?? "mcp";
      return {
        access_token: signJwt({ type: "access", client_id: client.client_id, scope }, ACCESS_TOKEN_TTL),
        token_type: "bearer",
        expires_in: ACCESS_TOKEN_TTL,
        scope,
        refresh_token: signJwt({ type: "refresh", client_id: client.client_id, scope }, REFRESH_TOKEN_TTL),
      };
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const payload = verifyJwt(token);
      if (payload["type"] !== "access") throw new Error("Not an access token");
      return {
        token,
        clientId: payload["client_id"] as string,
        scopes: typeof payload["scope"] === "string" ? payload["scope"].split(" ") : [],
        expiresAt: payload["exp"] as number | undefined,
      };
    },
  };
}

// ─── Login POST handler (mounted at /oauth/login in server.ts) ────────────────

export function loginHandler(req: Request, res: Response): void {
  const { password, client_id, redirect_uri, state, code_challenge, scopes } = req.body as {
    password?: string;
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    code_challenge?: string;
    scopes?: string;
  };

  if (!client_id || !redirect_uri || !code_challenge) {
    res.status(400).send("Missing required parameters");
    return;
  }

  const key = secret();
  const pwdBuf = Buffer.from(password ?? "");
  const keyBuf = Buffer.from(key);
  const ok = pwdBuf.length === keyBuf.length && timingSafeEqual(pwdBuf, keyBuf);

  if (!ok) {
    res.status(200).type("html").send(loginForm({
      clientId: client_id,
      redirectUri: redirect_uri,
      state: state ?? "",
      codeChallenge: code_challenge,
      scopes: scopes ?? "",
      error: "Invalid API key",
    }));
    return;
  }

  const code = signJwt({
    type: "code",
    client_id,
    redirect_uri,
    code_challenge,
    scopes: scopes ?? "mcp",
  }, AUTH_CODE_TTL);

  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.href);
}
