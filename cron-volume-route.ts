// app/api/cron/volume/route.ts
//
// Constrói o snapshot de volume e guarda. Roda no cron da Vercel, não na
// request do usuário: a varredura leva minutos e faz centenas de chamadas.
//
// vercel.json:
//   { "crons": [{ "path": "/api/cron/volume", "schedule": "17 */6 * * *" }] }

import { NextRequest, NextResponse } from "next/server";
import { buildVolumeSnapshot, probePublicTrades, type VolumeSnapshot } from "@/lib/qfex/volume";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const API = process.env.QFEX_API ?? "https://api.qfex.com";

/* ------------------------------------------------------------ armazenamento
   Default em memória para rodar local. Em produção troque por KV/Postgres —
   memória não sobrevive entre invocações serverless.                        */

export interface SnapshotStore {
  get(): Promise<VolumeSnapshot | null>;
  set(s: VolumeSnapshot): Promise<void>;
}

let inMemory: VolumeSnapshot | null = null;

export const store: SnapshotStore = {
  async get() {
    return inMemory;
  },
  async set(s) {
    inMemory = s;
  },
  // Com @vercel/kv:
  //   async get() { return (await kv.get<VolumeSnapshot>("qfex:volume:7d")) ?? null; },
  //   async set(s) { await kv.set("qfex:volume:7d", s, { ex: 60 * 60 * 12 }); },
};

/* ------------------------------------------------------------------ coleta */

const unwrap = (j: unknown): Record<string, unknown>[] =>
  Array.isArray(j) ? j : Array.isArray((j as { data?: unknown })?.data) ? (j as { data: Record<string, unknown>[] }).data : [];

async function activeSymbols(): Promise<string[]> {
  const res = await fetch(`${API}/refdata`, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!res.ok) return [];
  return unwrap(await res.json())
    .map((r) => (r.symbol ?? r.ticker_id ?? r.ticker) as string)
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

async function publicAccountIds(): Promise<string[]> {
  const ids: string[] = [];
  // O leaderboard aceita limit até 1000 e offset — pagina até acabar.
  for (let offset = 0; offset < 5000; offset += 1000) {
    const res = await fetch(
      `${API}/public/leaderboard?duration=1w&sort=absolute&limit=1000&offset=${offset}`,
      { headers: { Accept: "application/json" }, cache: "no-store" },
    );
    if (!res.ok) break;
    const rows = unwrap(await res.json());
    if (rows.length === 0) break;
    for (const r of rows) {
      const acc = r.account as { account_id?: string } | undefined;
      if (acc?.account_id) ids.push(acc.account_id);
    }
    if (rows.length < 1000) break;
  }
  return [...new Set(ids)];
}

/* -------------------------------------------------------------------- rota */

export async function GET(req: NextRequest) {
  // A Vercel manda o header; localmente use ?secret=
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (secret && auth !== `Bearer ${secret}` && req.nextUrl.searchParams.get("secret") !== secret) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }

  try {
    const [symbols, accountIds] = await Promise.all([activeSymbols(), publicAccountIds()]);

    if (accountIds.length === 0) {
      return NextResponse.json(
        { error: "nenhuma conta pública no leaderboard — nada a agregar" },
        { status: 424 },
      );
    }

    // ?probe=1 responde só o diagnóstico, sem varrer nada. Use isto primeiro:
    // diz se o tape público identifica a conta e qual formato de janela vale.
    if (req.nextUrl.searchParams.get("probe") === "1") {
      return NextResponse.json({
        symbols: symbols.length,
        accounts: accountIds.length,
        probe: await probePublicTrades(symbols[0] ?? "AAPL-USD"),
      });
    }

    const snapshot = await buildVolumeSnapshot({ symbols, accountIds, days: 7 });
    await store.set(snapshot);

    return NextResponse.json({
      ok: true,
      strategy: snapshot.strategy,
      accountsWithVolume: Object.keys(snapshot.byAccount).length,
      publicNotional: snapshot.publicNotional,
      venueNotional: snapshot.venueNotional,
      builtAt: snapshot.builtAt,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "falha ao montar o snapshot" },
      { status: 502 },
    );
  }
}
