// lib/qfex/volume.ts
//
// Volume por conta não existe como campo público na QFEX. O que existe são os
// trades das contas que marcaram o perfil como público. Volume é a soma de
// preço × quantidade desses fills.
//
// Dois caminhos, nesta ordem de preferência:
//
//   A. Varredura por símbolo — "Public Trades" (/public/trades), o endpoint que
//      alimenta a sobreposição de trades no gráfico. Uma chamada por símbolo
//      cobre todas as contas de uma vez. Só serve se o fill trouxer o
//      identificador da conta; o probe abaixo verifica isso.
//
//   B. Conta a conta — "Public Account Trades". Caro (uma chamada por trader),
//      mas funciona mesmo se a varredura vier anonimizada.
//
// Nada aqui roda na request do usuário: isso é trabalho de cron, gravando um
// snapshot. Veja cron-volume-route.ts.

const API = process.env.QFEX_API ?? "https://api.qfex.com";

/* ------------------------------------------------------------------ tipos */

export type AccountVolume = {
  accountId: string;
  /** Soma de preço × quantidade dos fills da conta na janela. */
  notional: number;
  fills: number;
  symbols: string[];
};

export type VolumeSnapshot = {
  from: string;
  to: string;
  /** "sweep" = varredura por símbolo, "per-account" = fallback conta a conta. */
  strategy: "sweep" | "per-account";
  byAccount: Record<string, AccountVolume>;
  /** Volume somado das contas públicas, contando um lado por trade. */
  publicNotional: number;
  /** Volume do venue no mesmo período, quando disponível, para calcular cobertura. */
  venueNotional: number | null;
  builtAt: string;
};

type RawTrade = Record<string, unknown>;

/* ------------------------------------------------------ leitura defensiva */

const numOf = (o: RawTrade, ...keys: string[]): number | null => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
};

const strOf = (o: RawTrade, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length) return v;
    if (typeof v === "number") return String(v);
  }
  return null;
};

const unwrap = (j: unknown): RawTrade[] => {
  if (Array.isArray(j)) return j as RawTrade[];
  if (j && typeof j === "object") {
    for (const k of ["data", "trades", "results"]) {
      const v = (j as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as RawTrade[];
    }
  }
  return [];
};

/** Identificador da conta dono do fill. Null = tape anônimo. */
const accountOf = (t: RawTrade): string | null =>
  strOf(t, "account_id", "accountId", "user_id", "userId", "account", "username");

/** Nocional do fill. Alguns venues já entregam pronto; se não, preço × qty. */
const notionalOf = (t: RawTrade): number | null => {
  const direct = numOf(t, "notional", "value", "quote_quantity");
  if (direct !== null) return Math.abs(direct);
  const px = numOf(t, "price", "fill_price", "px", "trade_price");
  const qty = numOf(t, "quantity", "qty", "size", "amount", "base_quantity");
  if (px === null || qty === null) return null;
  return Math.abs(px * qty);
};

const tradeIdOf = (t: RawTrade): string | null =>
  strOf(t, "trade_id", "tradeId", "id", "execution_id", "fill_id");

/* ------------------------------------------- descoberta do formato de query */

/**
 * Os nomes dos parâmetros de janela variam entre endpoints da QFEX: o histórico
 * de candles usa fromISO/toISO, outros usam from/to. Em vez de fixar um chute,
 * testamos as variantes uma vez e guardamos a que respondeu.
 */
type QueryStyle = "iso" | "plain" | "epoch";
const QUERY_STYLES: QueryStyle[] = ["iso", "plain", "epoch"];

function windowParams(style: QueryStyle, from: Date, to: Date): string {
  switch (style) {
    case "iso":
      return `fromISO=${from.toISOString()}&toISO=${to.toISOString()}`;
    case "plain":
      return `from=${from.toISOString()}&to=${to.toISOString()}`;
    case "epoch":
      return `from=${from.getTime()}&to=${to.getTime()}`;
  }
}

let resolvedStyle: QueryStyle | null = null;

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

/* --------------------------------------------------------------- endpoints
   Os dois paths abaixo saem do OpenAPI ("Public Trades" e "Public Account
   Trades" na seção /public). Confirme no DevTools e ajuste aqui se divergir —
   estão isolados justamente para serem o único ponto de conserto.          */

const PUBLIC_TRADES = (symbol: string, qs: string, limit: number) =>
  `/public/trades?symbol=${encodeURIComponent(symbol)}&${qs}&limit=${limit}`;

const ACCOUNT_TRADES = (accountId: string, qs: string, limit: number) =>
  `/public/account/${encodeURIComponent(accountId)}/trades?${qs}&limit=${limit}`;

/* ------------------------------------------------------------------- probe */

export type Probe = {
  ok: boolean;
  hasAccountId: boolean;
  style: QueryStyle | null;
  sample: number;
  note: string;
};

/**
 * Descobre se a varredura por símbolo é viável. Roda uma vez por deploy, não a
 * cada snapshot: se o tape público vier sem conta, o caminho A está morto e
 * caímos no B.
 */
export async function probePublicTrades(symbol: string): Promise<Probe> {
  const to = new Date();
  const from = new Date(to.getTime() - 60 * 60 * 1000);

  for (const style of QUERY_STYLES) {
    try {
      const rows = unwrap(await getJson(PUBLIC_TRADES(symbol, windowParams(style, from, to), 5)));
      resolvedStyle = style;
      const hasAccountId = rows.some((t) => accountOf(t) !== null);
      return {
        ok: true,
        hasAccountId,
        style,
        sample: rows.length,
        note: hasAccountId
          ? "tape público identifica a conta — varredura por símbolo liberada"
          : rows.length === 0
            ? "endpoint respondeu vazio nesta janela; teste um símbolo mais líquido antes de concluir"
            : "tape público é anônimo — só resta o caminho conta a conta",
      };
    } catch {
      // tenta o próximo formato de janela
    }
  }
  return {
    ok: false,
    hasAccountId: false,
    style: null,
    sample: 0,
    note: "nenhum formato de query respondeu; confira o path em PUBLIC_TRADES",
  };
}

/* ------------------------------------------------------------- agregação */

type Acc = Map<string, { notional: number; fills: number; symbols: Set<string> }>;

function add(acc: Acc, accountId: string, symbol: string, notional: number) {
  const cur = acc.get(accountId) ?? { notional: 0, fills: 0, symbols: new Set<string>() };
  cur.notional += notional;
  cur.fills += 1;
  cur.symbols.add(symbol);
  acc.set(accountId, cur);
}

/**
 * Caminho A. Varre símbolo por símbolo e agrega por conta.
 *
 * Dedupe por (trade_id, conta): quando as duas pontas de um trade são públicas,
 * o mesmo trade aparece duas vezes, uma por conta. Isso está certo do ponto de
 * vista do trader — cada um negociou aquele nocional — mas significa que a soma
 * das contas conta o trade duas vezes em relação ao volume do venue. Por isso a
 * cobertura divide por dois lá embaixo.
 */
async function sweepBySymbol(
  symbols: string[],
  from: Date,
  to: Date,
  pageSize = 500,
): Promise<Acc> {
  const style = resolvedStyle ?? "iso";
  const acc: Acc = new Map();
  const seen = new Set<string>();

  for (const symbol of symbols) {
    let cursor = new Date(to);
    // Pagina para trás até esvaziar a janela ou bater o teto de páginas.
    for (let page = 0; page < 40; page++) {
      let rows: RawTrade[];
      try {
        rows = unwrap(await getJson(PUBLIC_TRADES(symbol, windowParams(style, from, cursor), pageSize)));
      } catch {
        break; // símbolo sem dado ou rate limit: segue para o próximo
      }
      if (rows.length === 0) break;

      let oldest = cursor;
      for (const t of rows) {
        const accountId = accountOf(t);
        const notional = notionalOf(t);
        if (!accountId || notional === null) continue;

        const id = tradeIdOf(t);
        const key = id ? `${id}:${accountId}` : `${symbol}:${accountId}:${notional}:${strOf(t, "time", "timestamp", "created_at")}`;
        if (seen.has(key)) continue;
        seen.add(key);

        add(acc, accountId, symbol, notional);

        const ts = strOf(t, "time", "timestamp", "created_at", "executed_at");
        if (ts) {
          const d = new Date(ts);
          if (!Number.isNaN(d.getTime()) && d < oldest) oldest = d;
        }
      }

      if (rows.length < pageSize || oldest <= from || oldest >= cursor) break;
      cursor = oldest;
      await new Promise((r) => setTimeout(r, 120)); // respiro para o rate limit
    }
  }
  return acc;
}

/** Caminho B. Uma chamada por conta — usado quando o tape vem anônimo. */
async function sweepByAccount(accountIds: string[], from: Date, to: Date): Promise<Acc> {
  const style = resolvedStyle ?? "iso";
  const acc: Acc = new Map();
  const batch = 6;

  for (let i = 0; i < accountIds.length; i += batch) {
    await Promise.all(
      accountIds.slice(i, i + batch).map(async (accountId) => {
        try {
          const rows = unwrap(
            await getJson(ACCOUNT_TRADES(accountId, windowParams(style, from, to), 1000)),
          );
          for (const t of rows) {
            const notional = notionalOf(t);
            if (notional === null) continue;
            add(acc, accountId, strOf(t, "symbol", "ticker_id") ?? "—", notional);
          }
        } catch {
          // conta sem trades públicos na janela
        }
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
  }
  return acc;
}

/* ------------------------------------------------------- volume do venue */

async function venueNotional(days: number): Promise<number | null> {
  try {
    const raw = unwrap(await getJson("/symbols/metrics"));
    const daily = raw.reduce((sum, m) => {
      const v = numOf(m as RawTrade, "volume_24h_usd", "quote_volume_24h", "volume_24h", "target_volume");
      return sum + (v ?? 0);
    }, 0);
    return daily > 0 ? daily * days : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- snapshot */

export async function buildVolumeSnapshot(opts: {
  symbols: string[];
  accountIds: string[];
  days?: number;
  forcePerAccount?: boolean;
}): Promise<VolumeSnapshot> {
  const days = opts.days ?? 7;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);

  let strategy: VolumeSnapshot["strategy"] = "per-account";
  let acc: Acc;

  if (!opts.forcePerAccount && opts.symbols.length) {
    const probe = await probePublicTrades(opts.symbols[0]);
    if (probe.ok && probe.hasAccountId) {
      strategy = "sweep";
      acc = await sweepBySymbol(opts.symbols, from, to);
    } else {
      acc = await sweepByAccount(opts.accountIds, from, to);
    }
  } else {
    acc = await sweepByAccount(opts.accountIds, from, to);
  }

  // Fora do universo público não interessa: filtra pelo ranking recebido.
  const wanted = new Set(opts.accountIds);
  const byAccount: Record<string, AccountVolume> = {};
  let total = 0;

  for (const [accountId, v] of acc) {
    if (wanted.size && !wanted.has(accountId)) continue;
    byAccount[accountId] = {
      accountId,
      notional: v.notional,
      fills: v.fills,
      symbols: [...v.symbols],
    };
    total += v.notional;
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    strategy,
    byAccount,
    // Metade porque um trade entre duas contas públicas foi contado nas duas.
    publicNotional: strategy === "sweep" ? total / 2 : total,
    venueNotional: await venueNotional(days),
    builtAt: new Date().toISOString(),
  };
}

/** Fatia do tape que a amostra pública representa. 0.12 = enxergamos 12%. */
export function coverage(s: VolumeSnapshot): number | null {
  if (!s.venueNotional || s.venueNotional <= 0) return null;
  return s.publicNotional / s.venueNotional;
}
