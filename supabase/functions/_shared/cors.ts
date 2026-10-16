const ALLOWED_ORIGINS = new Set([
  "https://bishnupriyafuels.fnsventures.in",
  "https://fnsventures.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

let currentOrigin = "https://bishnupriyafuels.fnsventures.in";

export function bindRequestCors(req: Request) {
  const origin = req.headers.get("origin") || "";
  currentOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://bishnupriyafuels.fnsventures.in";
}

export function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": currentOrigin,
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
