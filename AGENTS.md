---
name: app-template AGENTS
description: app-template リポジトリで作業するエージェント・開発者向けのガイド
---

# app-template ガイド（AGENTS）

## プロジェクト概要

- **app-template** は 0 → 1 アプリ向けのテンプレートリポジトリです。clone 後 30 分でローカル起動、1 時間で staging URL、1 週間でプロトタイプを到達点として設計されています。
- 想定ユースケース・撤退ライン・採用スタック・コーディング規約の **詳細は [`README.md`](./README.md) が一次ソース**です。本ドキュメントはそれを前提とした作業ハンドブックとして扱ってください。
- 実装計画とフェーズ構成は [`docs/template-plan.md`](./docs/template-plan.md)、エラーハンドリング詳細は [`docs/error-handling.md`](./docs/error-handling.md) を参照します。

## 採用スタック（要旨）

| レイヤ | 採用 |
| --- | --- |
| 画面 | React + TanStack Router (file-based) + Vite |
| API | Hono on Cloudflare Workers |
| 配信 | Cloudflare Pages（web）+ Workers（api） |
| DB | Cloudflare D1（SQLite） |
| ストレージ | Cloudflare R2（S3 互換） |
| 認証 | Better Auth |
| ORM | Drizzle（暫定第一候補、Phase 0 で確定） |
| バリデーション | zod（必須） |
| API クライアント | Hono `hc<AppType>`（必須） |
| データ取得 | TanStack Query（`useQuery` / `useMutation`） |
| フォーム | React Hook Form + zod |
| テスト | Vitest / `@cloudflare/vitest-pool-workers` / Playwright |
| パッケージ管理 | npm |

## リポジトリ構成（予定）

```
app-template/
├─ apps/
│  ├─ web/           # React + TanStack Router + Vite
│  └─ api/           # Hono on Workers（DDD レイヤ構成 / Drizzle schema / migrations）
├─ packages/
│  └─ shared/        # zod schema / AppType / hc クライアント
├─ docs/             # 実装計画・ADR・ガイド
├─ scripts/
└─ .github/workflows/
```

- D1 / Drizzle は `apps/api/db/schema.ts` を正とし、migration は Drizzle から `apps/api/db/migrations/` に生成します。
- ドメインごとの詳細ガイドは、各ディレクトリができ次第 `apps/api/AGENTS.md` / `apps/web/AGENTS.md` として追加し、ここからリンクします。

## ルートで利用する主なコマンド

```bash
node --version        # 22.x を使用
npm install           # ワークスペース全体の依存をインストール
npm run dev           # web と api を同時起動

# 品質チェック / CI
npm run ci            # lint / typecheck / test / build
npm run lint          # ESLint
npm run typecheck     # TypeScript 型チェック
npm run test          # Vitest

# Cloudflare
npm run db:generate   # Drizzle schema から migration SQL を生成
npm run db:migrate    # D1 マイグレーション適用
npm run cf:deploy     # Pages / Workers デプロイ
```

具体的なスクリプト名・分割は Phase 0 で確定します。差異が出た時点でこのセクションを更新してください。

## コーディング規約（要旨）

詳細は README の「コーディング規約（テンプレで強制）」が一次ソース。要点のみ:

1. **型安全**: `strict: true` + `noUncheckedIndexedAccess`、`as` / `!` 禁止。外部入力は zod で parse、必要なら型ガード。例外は理由コメント必須。
2. **バリデーションは zod に集約**: 外部入力は全て `packages/shared/src/schemas.ts` のスキーマで parse。Hono は `@hono/zod-validator` を必ず通す。
3. **API は Hono RPC**: `apps/api` で `export type AppType = typeof app`、フロントは `hc<AppType>` 経由でしか呼ばない（生 fetch 禁止）。
4. **データ取得は TanStack Query**: `useQuery` / `useMutation` を使う。`useState` + `useEffect` で fetch するのは禁止。
5. **フォームは React Hook Form + zod**: `useForm({ resolver: zodResolver(schema) })` を既定。
6. **`useState` / `useEffect` は最小限**: ローカル UI 状態と本当に必要な副作用のみ。やむを得ない場合は理由コメント。
7. **コメント方針**: 通常は書かない（命名で説明）。規約から外れる箇所のみ理由コメント必須。**既存コメントは消さない**。
8. **エラーハンドリング**: `Result<T, E>` で予期した失敗を返し、`UnexpectedError` のみ throw。詳細は [`docs/error-handling.md`](./docs/error-handling.md)。
9. **自動テスト**: backend は in-memory SQLite を使った integration test を主軸、frontend は Vitest + MSW + Testing Library、E2E は Playwright で golden path 1 本。各機能には参考テストを必ず添える。

## 設計ルール（要旨）

### apps/api（Hono on Workers）— DDD レイヤ構成

- 「集約 + 1 集約 = 1 Repository + CQRS（read は queries に分離）」
- 集約間は **ID 経由で参照**。複数集約をまたぐトランザクションは service で組み立てる
- handler は `Deps` のみ受け取り、`c.var.dbClient` / `c.var.storageClient` を直接触らない
- 1 service = 1 use case、公開メソッドは `execute` のみ
- DB レコードの型は **ORM 生成物**を参照（手書きで列挙しない）
- 関数引数は **1 つ → positional / 2 つ以上 → named (object)**
- service / query / repository のモックは `src/__tests__/mocks/` の **生成関数** を `beforeEach` で毎回生成（ファイルスコープで使い回さない）

### apps/web（React + TanStack Router）— package by feature + group routing

- 画面は `routes/` のみ。ロジック / UI は `features/<feature>/` に閉じ込める
- `routes/(group)/` で **group routing**（認証境界・レイアウト境界を URL に出さずに分離）
- feature 同士の直接 import は禁止。共有したくなったら `shared/` に昇格
- feature の公開境界は `features/<feature>/index.ts` に固定
- UI トークンは `src/shared/designSystem/` に集約。**物理トークンを画面で直接使わない**（必ず semantic トークン経由）

## ドキュメント索引

- [`README.md`](./README.md) — テンプレ全体の方針・スタック・規約（一次ソース）
- [`docs/template-plan.md`](./docs/template-plan.md) — 実装計画とフェーズ構成
- [`docs/error-handling.md`](./docs/error-handling.md) — Result 型 + Problem レスポンス設計

新しいトピックを追加する際は、まず該当ドメイン（README / docs / 各サブ AGENTS）に書き、必要ならこの索引にリンクを足してください。
