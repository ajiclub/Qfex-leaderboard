# QFEX stats

Quadro público não oficial da [QFEX](https://qfex.com): ranking das contas que marcaram
o perfil como público, com PnL, retorno e volume estimado no período.

Nada aqui é oficial nem afiliado à QFEX. Tudo vem de endpoints públicos da API.

## O que roda onde

| Caminho | O que é |
| --- | --- |
| `public/board.html` | O painel. Estático, sem build. Acessível em `/board.html`, e a raiz redireciona para ele. |
| `app/api/board/route.ts` | Busca leaderboard, perfis e market data, junta com o snapshot de volume, devolve um payload só. Cache de 10 min. |
| `app/api/cron/volume/route.ts` | Monta o snapshot de volume. Roda no cron, nunca na visita do usuário. |
| `lib/qfex/volume.ts` | O agregador: varre trades públicos e soma nocional por conta. |

## Subir

```bash
npm install
npm run dev          # http://localhost:3000
```

Para publicar: suba o repositório no GitHub e importe na Vercel. Ela detecta Next.js
sozinha; não precisa configurar build.

Não funciona no GitHub Pages. Pages serve arquivo estático e não executa as rotas —
o painel abriria, mas cairia nos dados de exemplo, porque a chamada direta ao
`api.qfex.com` pelo navegador esbarra em CORS. É exatamente o que a rota resolve.

### Variáveis de ambiente

Copie `.env.example` para `.env.local` e defina `CRON_SECRET`. No deploy, cadastre a
mesma variável no painel da Vercel.

## Volume: rode o diagnóstico antes do cron

Volume por conta não é um campo público da QFEX. É calculado somando preço × quantidade
dos trades públicos. Existem dois caminhos, e qual deles vale depende de um detalhe que
precisa ser verificado no ar:

```
GET /api/cron/volume?probe=1&secret=SEU_SEGREDO
```

A resposta diz quantos símbolos e contas foram encontrados e, principalmente, se o tape
público identifica a conta de cada fill.

- `hasAccountId: true` → varredura por símbolo. Barata: uma passada cobre todo mundo.
- `hasAccountId: false` → conta a conta. Funciona, mas é uma chamada por trader.

O código escolhe sozinho; o probe existe para você saber o que esperar. Se vier
`hasAccountId: false` com `sample: 0`, teste de novo num horário de mercado movimentado
antes de concluir que o tape é anônimo — pode ser só uma janela sem negócio.

Depois, gere o primeiro snapshot à mão:

```
GET /api/cron/volume?secret=SEU_SEGREDO
```

O `vercel.json` já agenda isso a cada 6 horas. Enquanto o snapshot não existir, a coluna
de volume mostra travessão em vez de zero — zero seria mentira.

### Armazenamento do snapshot

O padrão guarda em memória, o que serve para rodar local mas **não sobrevive entre
invocações serverless**. Em produção, troque pelo bloco comentado com `@vercel/kv`
dentro de `app/api/cron/volume/route.ts`, ou por qualquer banco.

## Pontos que precisam de confirmação no DevTools

Três coisas não estão no OpenAPI público e foram escritas de forma defensiva — o código
tenta variantes em vez de assumir uma. Vale fixar depois de conferir:

1. **Path do perfil público.** Constante `PROFILE_PATH` em `app/api/board/route.ts`.
   Abra a QFEX, passe o mouse sobre um trader e veja qual chamada o card dispara.
2. **Nome do campo do handle do X.** A lista `X_KEYS` cobre as variantes plausíveis.
   Está na mesma resposta do item anterior.
3. **Path e parâmetros dos trades públicos.** `PUBLIC_TRADES` e `ACCOUNT_TRADES` em
   `lib/qfex/volume.ts`. O formato da janela (`fromISO/toISO`, `from/to` ou epoch) é
   descoberto pelo probe automaticamente.

## Handles do X

Só aparece link quando o próprio trader declarou o handle: no campo que a QFEX devolve,
ou escrito na bio como `@fulano` ou `x.com/fulano`. Nada é deduzido do nome de usuário —
um palpite errado apontaria o painel para um estranho. As duas origens são distinguidas
visualmente na tabela.

## Limites honestos

- Cobre só quem tornou o perfil público. Não é o volume da exchange, é o da amostra
  visível — daí a métrica "do tape visível" no topo.
- Volume é estimativa calculada, não número chancelado pela QFEX.
- A QFEX é invite-only e bloqueia onboarding em vários países, então o universo é menor
  do que parece.
