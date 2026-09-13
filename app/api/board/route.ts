// app/api/board/route.ts
//
// Busca o leaderboard público e o market data da QFEX no servidor, junta o mapa
// de redes sociais e devolve um payload único para o front. Rodar server-side
// resolve CORS e permite cachear — o front sozinho bateria na API a cada visita.
//
// Endpoints (todos sem autenticação):
//   GET https://api.qfex.com/public/leaderboard?duration=&sort=&limit=&offset=
//   GET https://api.qfex.com/symbols/metrics
//   GET https://api.qfex.com/refdata
//
// Os dois últimos vêm do CLI oficial (github.com/QFEX-org/cli, cmd/market.go).
// O OpenAPI também documenta /md/contracts com um formato tipo CoinGecko;
// se /symbols/metrics mudar, é o fallback natural.

import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/qfex/store";
import { coverage } from "@/lib/qfex/volume";

const API = process.env.QFEX_API ?? "https://api.qfex.com";
const CACHE_SECONDS = 600;

export const revalidate = 0; // controlamos o cache na mão, abaixo

/* ------------------------------------------------------------------ tipos */

/** Espelha PublicAccount do OpenAPI da QFEX. */
type PublicAccount = {
  account_id: string;
  user_id: string;
  is_public: boolean;
  username?: string;
  avatar_url?: string;
};

/** Espelha PublicLeaderboardEntry. */
type LeaderboardEntry = {
  rank: number;
  account: PublicAccount;
  pnl: number;
  return_percent: number;
  start_equity: number;
  end_equity: number;
};

type LeaderboardResponse = {
  data: LeaderboardEntry[] | null;
  count: number;
  duration: string;
  sort: string;
  start?: string;
  end?: string;
};

type Social = { x?: string };

/** De onde saiu o handle: campo da QFEX ou texto da bio. Nada é deduzido. */
type SocialSource = "api" | "bio";

type Row = LeaderboardEntry & {
  bio: string | null;
  memberSince: string | null;
  /** Estimado a partir dos trades públicos. Null = snapshot ainda não rodou. */
  volume: number | null;
  social: (Social & { source: SocialSource }) | null;
};

type Ticker = {
  symbol: string;
  mark: number | null;
  change: number | null;
  funding: number | null;
  openInterestUsd: number | null;
  volume24h: number | null;
};

/* ------------------------------------------------------- helpers de leitura */

const unwrap = <T,>(j: unknown): T[] => {
  if (Array.isArray(j)) return j as T[];
  if (j && typeof j === "object" && Array.isArray((j as { data?: unknown }).data)) {
    return (j as { data: T[] }).data;
  }
  return [];
};

/**
 * Lê o primeiro campo presente. Os nomes exatos de /symbols/metrics não estão
 * documentados campo a campo, então tentamos as variantes plausíveis em vez de
 * quebrar quando a API renomeia uma chave.
 */
const num = (o: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

const str = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length) return v;
  }
  return null;
};

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/json" },
    signal,
    next: { revalidate: CACHE_SECONDS },
  });
  if (!res.ok) throw new Error(`${path} respondeu ${res.status}`);
  return res.json();
}

/* -------------------------------------------------------------- rede social */

/**
 * O card de perfil da QFEX mostra o ícone do X, então pode haver um campo
 * dedicado no payload de /public/account. O nome exato não está no OpenAPI:
 * abra qfex.com, passe o mouse num trader e veja a chave no DevTools.
 */
const X_KEYS = ["x_handle", "x_username", "twitter_handle", "twitter_username", "twitter", "x"];

/**
 * Handle escrito na bio. Duas formas: link colado ou @mention. O teto de 15
 * caracteres e o alfabeto restrito são regra do próprio X, e servem de
 * validação — descartam e-mail, hashtag e frase solta.
 */
const BIO_URL = /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/@?([A-Za-z0-9_]{1,15})\b/i;
const BIO_AT = /(?:^|[^\w@./])@([A-Za-z0-9_]{1,15})\b/;

function handleFromBio(bio: unknown): string | null {
  if (typeof bio !== "string" || !bio) return null;
  return bio.match(BIO_URL)?.[1] ?? bio.match(BIO_AT)?.[1] ?? null;
}

function handleFromProfile(profile: Record<string, unknown> | null): string | null {
  if (!profile) return null;
  for (const k of X_KEYS) {
    const v = profile[k];
    if (typeof v === "string" && v.trim()) {
      return v.trim().replace(/^@/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "");
    }
  }
  return null;
}

/**
 * Só vira link o que o próprio trader declarou: campo da QFEX ou texto da bio.
 * Nada é deduzido do nome de usuário — um palpite errado aponta o painel para
 * um estranho. `source` viaja até o front porque as duas origens não são iguais.
 */
function socialFor(profile: Record<string, unknown> | null): Row["social"] {
  const linked = handleFromProfile(profile);
  if (linked) return { x: linked, source: "api" };

  const inBio = handleFromBio(profile?.bio);
  if (inBio) return { x: inBio, source: "bio" };

  return null;
}

/**
 * Busca o perfil público de uma conta. O path exato precisa ser confirmado —
 * o OpenAPI lista "Public Account" na seção /public; ajuste PROFILE_PATH depois
 * de olhar a chamada real no DevTools.
 */
const PROFILE_PATH = (id: string) => `/public/account/${encodeURIComponent(id)}`;

const profileCache = new Map<string, { at: number; data: Record<string, unknown> | null }>();
const PROFILE_TTL = 6 * 60 * 60 * 1000; // o handle muda raramente; 6h basta

async function getProfile(accountId: string, signal: AbortSignal) {
  const cached = profileCache.get(accountId);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.data;
  try {
    const raw = (await getJson(PROFILE_PATH(accountId), signal)) as Record<string, unknown>;
    const data = (raw?.data ?? raw) as Record<string, unknown>;
    profileCache.set(accountId, { at: Date.now(), data });
    return data;
  } catch {
    // Perfil ausente não invalida a linha — o trader só fica sem handle.
    profileCache.set(accountId, { at: Date.now(), data: null });
    return null;
  }
}

/** Roda as buscas de perfil em lotes para não estourar o rate limit. */
async function mapWithConcurrency<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/* -------------------------------------------------------------- normalizers */

function normalizeTickers(raw: unknown): Ticker[] {
  return unwrap<Record<string, unknown>>(raw)
    .map((m) => ({
      symbol: str(m, "symbol", "ticker_id", "ticker") ?? "—",
      mark: num(m, "mark_price", "last_price", "mark", "index_price"),
      change: num(m, "change_24h_percent", "price_change_percent_24h", "change_percent"),
      funding: num(m, "funding_rate", "next_funding_rate"),
      openInterestUsd: num(m, "open_interest_usd", "open_interest_notional"),
      volume24h: num(m, "volume_24h_usd", "quote_volume_24h", "volume_24h", "target_volume"),
    }))
    .filter((t) => t.mark !== null)
    .sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0));
}

/* -------------------------------------------------------------------- rota */

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;

  // duration e sort são repassados; limitamos aos valores que a API aceita
  const duration = ["1d", "1w", "1m", "all"].includes(q.get("duration") ?? "")
    ? q.get("duration")!
    : "1w";
  const sort = q.get("sort") === "percent" ? "percent" : "absolute";
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 100), 1), 1000);
  const query = (q.get("q") ?? "").trim().toLowerCase().replace(/^@/, "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const [boardRaw, metricsRaw] = await Promise.all([
      getJson(
        `/public/leaderboard?duration=${duration}&sort=${sort}&limit=${limit}`,
        controller.signal,
      ),
      getJson("/symbols/metrics", controller.signal).catch(() => []),
    ]);

    const board = boardRaw as LeaderboardResponse;
    const entries = board.data ?? [];

    const profiles = await mapWithConcurrency(entries, 8, (e) =>
      e.account?.account_id
        ? getProfile(e.account.account_id, controller.signal)
        : Promise.resolve(null),
    );

    // Volume vem do snapshot montado pelo cron — nunca calculado aqui.
    // Ausente = ainda não rodou, e a coluna aparece vazia em vez de zerada.
    const snapshot = await store.get();

    const all: Row[] = entries.map((e, i) => ({
      ...e,
      rank: e.rank ?? i + 1,
      bio: (profiles[i]?.bio as string) ?? null,
      memberSince: (profiles[i]?.created_at as string) ?? null,
      volume: snapshot?.byAccount[e.account?.account_id ?? ""]?.notional ?? null,
      social: socialFor(profiles[i]),
    }));

    // Filtra depois de enriquecer: só assim a busca alcança o handle, que não
    // existe no payload do leaderboard. O rank preservado é o do quadro cheio.
    const rows = query
      ? all.filter(
          (r) =>
            (r.account?.username ?? "").toLowerCase().includes(query) ||
            (r.social?.x ?? "").toLowerCase().includes(query),
        )
      : all;

    const winners = rows.filter((r) => r.pnl > 0).length;
    const net = rows.reduce((s, r) => s + r.pnl, 0);
    const gross = rows.reduce((s, r) => s + Math.abs(r.pnl), 0);
    const volume = rows.reduce((s, r) => s + (r.volume ?? 0), 0);

    return NextResponse.json(
      {
        duration,
        sort,
        window: { start: board.start ?? null, end: board.end ?? null },
        totals: { accounts: rows.length, winners, net, gross, volume },
        volumeSnapshot: snapshot
          ? {
              strategy: snapshot.strategy,
              builtAt: snapshot.builtAt,
              from: snapshot.from,
              to: snapshot.to,
              // Fatia do tape que a amostra pública representa.
              coverage: coverage(snapshot),
            }
          : null,
        rows,
        tickers: normalizeTickers(metricsRaw),
        fetchedAt: new Date().toISOString(),
      },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 3}`,
        },
      },
    );
  } catch (err) {
    // A falha é informativa, não decorativa: o front precisa saber se caiu
    // timeout, 4xx da QFEX ou schema inesperado, para escolher o que mostrar.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falha ao consultar a QFEX" },
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/* ---------------------------------------------------------------------------
   Volume estimado por trader — o que falta para chegar perto do entropystats.
   A QFEX só expõe volume da própria conta (autenticado). Para as contas
   públicas dá para somar o nocional dos trades pelo endpoint "Public Account
   Trades" da seção /public do OpenAPI, iterando o leaderboard. Confirme o path
   e o shape em docs.qfex.com antes de ligar isso, respeite o rate limit e
   guarde o resultado — não dá para fazer na request do usuário.

   async function estimateVolume(accountId: string, since: string) {
     const trades = unwrap<Record<string, unknown>>(
       await getJson(`/public/account/${accountId}/trades?from=${since}`, signal),
     );
     return trades.reduce((sum, t) => {
       const px = num(t, "price", "fill_price") ?? 0;
       const qty = num(t, "quantity", "qty", "size") ?? 0;
       return sum + px * qty;
     }, 0);
   }
--------------------------------------------------------------------------- */
