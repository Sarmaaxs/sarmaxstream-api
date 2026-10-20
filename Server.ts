import Redis from "ioredis";
import * as Sentry from "@sentry/bun";

Sentry.init({ dsn: Bun.env.SENTRY_DSN, environment: "production", tracesSampleRate: 0.1 });

const TMDB_BASE = "https://api.themoviedb.org/3";
const IMG_BASE = "https://image.tmdb.org/t/p";

// Public on purpose (signed-out browsing). Locked to the app's endpoints, validated,
// rate limited per IP and cached in Redis. The TMDB token stays server-side.
const ALLOWED_PATHS = [
  /^trending\/all\/(day|week)$/,
  /^(movie|tv)\/(popular|top_rated)$/,
  /^discover\/(movie|tv)$/,
  /^genre\/(movie|tv)\/list$/,
  /^search\/multi$/,
  /^(movie|tv)\/\d{1,10}$/,
  /^tv\/\d{1,10}\/season\/\d{1,3}$/,
];
const APPENDABLE = new Set(["videos", "similar", "credits"]);
const PARAM_RULES: Record<string, (v: string) => boolean> = {
  page: (v) => /^\d{1,3}$/.test(v) && Number(v) >= 1 && Number(v) <= 500,
  query: (v) => v.length > 0 && v.length <= 100,
  with_genres: (v) => /^[\d,|]{1,60}$/.test(v),
  sort_by: (v) => /^[a-z_]{1,30}\.(asc|desc)$/.test(v),
  append_to_response: (v) => v.split(",").every((x) => APPENDABLE.has(x)),
  include_adult: (v) => v === "false",
};

const redis = Bun.env.REDIS_URL
  ? new Redis(Bun.env.REDIS_URL, { family: 0, maxRetriesPerRequest: 1, enableOfflineQueue: false })
  : null;
redis?.on("error", (e) => console.error("redis:", e.message));

async function allowed(ip: string, max = 300, windowSec = 60): Promise<boolean> {
  if (!redis) return true;
  try {
    const key = `rl:${ip}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, windowSec);
    return n <= max;
  } catch {
    return true; // fail open if Redis is down
  }
}

async function cached<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit);
    } catch {}
  }
  const value = await load();
  if (redis) redis.set(key, JSON.stringify(value), "EX", ttlSec).catch(() => {});
  return value;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS, ...extra } });

async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (pathname === "/health") return json({ ok: true });
  if (pathname !== "/tmdb" || req.method !== "POST") return json({ error: "not found" }, 404);

  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await allowed(ip))) return json({ error: "too many requests" }, 429, { "Retry-After": "60" });

  const token = Bun.env.TMDB_ACCESS_TOKEN;
  if (!token) return json({ error: "TMDB token not configured" }, 500);

  const body: any = await req.json().catch(() => ({}));
  const cleanPath = String(body?.path ?? "").replace(/^\//, "");
  if (!ALLOWED_PATHS.some((re) => re.test(cleanPath))) return json({ error: "endpoint not permitted" }, 400);

  const url = new URL(`${TMDB_BASE}/${cleanPath}`);
  for (const [k, raw] of Object.entries(body?.params ?? {})) {
    if (!Object.hasOwn(PARAM_RULES, k) || raw == null || raw === "") continue;
    const value = String(raw);
    if (!PARAM_RULES[k](value)) return json({ error: `invalid param: ${k}` }, 400);
    url.searchParams.set(k, value);
  }
  url.searchParams.sort();

  try {
    const data = await cached(`tmdb:${url.pathname}${url.search}`, 600, async () => {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
      const out: any = await r.json();
      if (!r.ok) throw Object.assign(new Error(out.status_message || "TMDB error"), { status: r.status });
      return out;
    });
    return json({ data, imageBase: IMG_BASE });
  } catch (err: any) {
    if (err?.status) return json({ error: err.message }, err.status);
    Sentry.captureException(err);
    return json({ error: "internal error" }, 500);
  }
}

export default {
  port: Number(Bun.env.PORT) || 3000,
  fetch: handle,
};
