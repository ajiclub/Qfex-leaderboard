// lib/qfex/store.ts
//
// Onde o snapshot de volume fica guardado entre o cron e a rota do quadro.
// Vive fora das rotas porque arquivos route.ts do Next só podem exportar
// handlers — qualquer outro export quebra o build.

import type { VolumeSnapshot } from "./volume";

export interface SnapshotStore {
  get(): Promise<VolumeSnapshot | null>;
  set(s: VolumeSnapshot): Promise<void>;
}

/**
 * Padrão em memória: serve para rodar local, mas NÃO sobrevive entre
 * invocações serverless. Em produção o cron gravaria num processo e a rota
 * leria de outro, sempre vazio. Troque pelo bloco KV abaixo antes de publicar.
 */
let inMemory: VolumeSnapshot | null = null;

export const store: SnapshotStore = {
  async get() {
    return inMemory;
  },
  async set(s) {
    inMemory = s;
  },
};

/* Com @vercel/kv (npm i @vercel/kv), troque o objeto acima por:

import { kv } from "@vercel/kv";

const KEY = "qfex:volume:7d";

export const store: SnapshotStore = {
  async get() {
    return (await kv.get<VolumeSnapshot>(KEY)) ?? null;
  },
  async set(s) {
    await kv.set(KEY, s, { ex: 60 * 60 * 12 });
  },
};

*/
