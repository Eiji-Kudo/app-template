# app-template

0 → 1 アプリ向けテンプレート Repository。
clone 後 30 分でローカル起動、1 時間で staging URL、1 週間でプロトタイプを目指す。

詳細な実装計画は [`docs/template-plan.md`](./docs/template-plan.md) を参照。

---

## 想定ユースケース

向く:

- 業務系アプリ（ダッシュボード、運用補助、業務フォーム）
- 顧客向け PoC / クローズドβ
- ハッカソン / 個人プロダクトの立ち上げ
- 既存プロダクトに併設する小さな周辺アプリ

向かない:

- 強い同時接続 / 大量データ処理
- 既存 DB（オンプレ / RDB）を中心に据えるもの
- 厳格なネットワーク要件（VPC 内通信必須など）

---

## 技術スタック

| レイヤ | 採用 |
| --- | --- |
| 画面 | React + TanStack Router (file-based) + Vite |
| API | Hono on Cloudflare Workers |
| 配信 | Cloudflare Pages（web）+ Workers（api） |
| DB | Cloudflare D1（SQLite） |
| ストレージ | Cloudflare R2（S3 互換） |
| 認証 | Better Auth |
| ORM | Drizzle（暫定第一候補、Phase 0 で確定） |
| バリデーション | **zod**（必須） |
| API クライアント | **Hono `hc<AppType>`**（必須） |
| データ取得 | **TanStack Query (`useQuery`)** |
| フォーム | **React Hook Form** |
| テスト | Vitest / `@cloudflare/vitest-pool-workers` / Playwright |
| パッケージ管理 | npm |

---

## ルートコマンド

```bash
npm install
npm run ci            # lint / typecheck / test / build
npm run lint          # ESLint
npm run typecheck     # TypeScript 型チェック
npm run test          # Vitest
npm run build         # workspace build
npm run format        # Prettier check
```

`npm run dev` / `npm run db:migrate` / `npm run cf:deploy` は後続 Step で実体化する。現時点ではテンプレート利用者が次 Step の実装先を確認できる placeholder として用意している。

---

## コーディング規約（テンプレで強制）

このテンプレで作るアプリは、以下を **ESLint / tsconfig / レビュー** の 3 段で強制する。

### 1. 型安全

- **`tsconfig.json`**: `strict: true` + `noUncheckedIndexedAccess: true`
- **型アサーション禁止**: `as` / `as unknown as` / `!`（non-null assertion）は使わない
  - 外部入力は **zod でパースして型を得る**
  - 自前判定が必要なら **型ガード関数（`x is T`）** を書く
  - ESLint で `@typescript-eslint/consistent-type-assertions` / `no-non-null-assertion` を error
  - 例外的に必要なら **その行に理由コメントを必ず添える**
- **DB 型は ORM 生成物を正とする**（手書き型に置き換えない）

### 2. バリデーションは zod に集約

- すべての外部入力（HTTP body / query / params / 環境変数 / フォーム入力 / `localStorage` 等）は **zod スキーマでパース**してから使う
- スキーマは `packages/shared/src/schemas.ts` に集約し、フロント / バックで共有
- Hono ルートは `@hono/zod-validator` を必ず通し、ハンドラ内では `c.req.valid('json' | 'query' | 'param')` 経由でしか入力に触れない

### 3. API は Hono RPC（`hc<AppType>`）で型安全に

- `apps/api` で `export type AppType = typeof app` を export
- `packages/shared/src/client.ts` で `hc<AppType>(baseURL)` を export
- フロントは **生 `fetch` を直接書かない**。必ず `hc` クライアント経由
- ルート追加時はバックの型変更がフロント補完にそのまま反映される状態を維持

### 4. データ取得・更新は TanStack Query

- サーバ状態は **`useQuery` / `useMutation`** で扱う
- `useState` + `useEffect` で fetch する手書きは禁止
- queryKey / queryFn は `hc` クライアントを呼ぶ薄いラッパに集約

### 5. フォームは React Hook Form + zod

- `useForm({ resolver: zodResolver(schema) })` を既定とする
- フォーム state を `useState` で持たない

### 6. `useState` / `useEffect` の利用は最小限

- **`useState`**: ローカル UI 状態（モーダル開閉・入力フォーカス等）に限定
- **`useEffect`**: 副作用が本当に必要なときだけ
  - データ取得は `useQuery` を使う
  - 派生値は計算で出す（`useMemo` / 普通の式）
  - URL 同期は TanStack Router の `search` / `loader` を使う
- やむを得ず使う場合は **理由を 1 行コメントで書く**（例: `// useEffect: WebSocket subscribe のため`）

### 7. コメント方針

- 通常はコメントを書かない（コードと命名で説明）
- 上記「やむを得ず `useEffect` を使う」「やむを得ず型アサーションを使う」など、**規約から外れる箇所は理由コメント必須**
- 既存コメントは消さない

### 8. エラーハンドリング（Result 型 + Problem レスポンス）

「予期した失敗は Result で返し、`throw` するのは説明不能な障害（`UnexpectedError`）だけ」という方針を採る。

**タクソノミー**

| 種別 | 想定レイヤ | 役割 |
| --- | --- | --- |
| `DomainError<Reason>` | service / domain | 業務ルールや状態遷移の失敗。Result で呼び出し元に返す |
| `InfraError<Reason>` | repository / gateway | DB / 外部 API の決定的な失敗（ユニーク制約・存在しない ID 等）をビジネス文脈に写像 |
| `UnexpectedError` | 全レイヤ | 説明不能・人手対応が必要な障害。`throw` して `app.onError` で捕捉し Sentry に送る |

`core/errors/` に基底クラスを置き、`core/result.ts` に `Result<T, E>` / `success` / `err` / `isExpectedError` ヘルパーを置く。

**共通ルール**

- 予期した失敗は **必ず Result で返す**。`throw` してよいのは `UnexpectedError` のみ
- `reason` 文字列は使う関数のすぐ近くで `const X = "items.not_found" as const;` のように定義し、Result 型から union を**暗黙推論**させる
- `details` は `{ origin, meta?, traceId? }` の形。`DomainError` / `InfraError` は `origin` を自動付与するので呼び出し側は `meta`（ID・入力抜粋）と必要なら `traceId` を渡す
- repository / トランザクション内で `null` を返さない。その場で `err(new DomainError/InfraError)` に変換して伝える

**ハンドラ層**

- ハンドラは Result を受け取り、`switch (error.reason)` で Problem レスポンスに振る
- `core/http/schemas/error.schema.ts` に `buildBadRequestProblemSchema(codes)` 等のユーティリティを置き、OpenAPI スキーマ + `problem(...)` ビルダを 1 度に生成
- `ErrorCode` はステータスごとにグループ化（`ErrorCode[400].XYZ` / `ErrorCode[404].XYZ`）
- `default: return error.reason satisfies never;` で網羅性チェック
- 401 / 403 / 404 / 500 の汎用は `unauthorizedProblem` / `forbiddenProblem` / `notFoundProblem` / `internalServerErrorProblem` を再利用

**トランザクション**

- D1 のトランザクション内で `return err(...)` してもコミットされてしまう問題を避けるため、`core/db/runResultTransaction.ts` を提供
- 使い方:
  - コールバックは `Result<Payload, ExpectedError>` を返す（ジェネリクスは推論される）
  - 想定外は従来通り `throw new UnexpectedError(...)`（透過的に伝播、トランザクションはロールバック）
  - トランザクション内の I/O は必ず `tx` を使う（`dbClient` 直叩きは禁止）

**グローバル境界（`app.onError`）**

- `isExpectedError(err)` が true の場合、設計漏れとして `UnexpectedError` にラップし Sentry に送る（その上で 500 Problem を返す）
- それ以外は `Sentry.captureException(err)` を呼び、`origin` と `details` をタグに付与

ガイドラインの詳細とサンプルは [`docs/error-handling.md`](./docs/error-handling.md)。

### 9. 自動テスト

- **backend は原則 integration test**（API ハンドラ ↔ test DB）を書く
  - service / repository を個別にモックする unit test は最小限（網羅できない条件分岐に限る）
  - test DB は **in-memory SQLite**（`better-sqlite3 :memory:` + Drizzle）を採用し、`beforeEach` で毎回マイグレーション済み DB を作る
  - `app.request('/api/...')` で実 Hono アプリを叩き、in-memory DB の状態を検証
- **frontend** は features の hooks（hc + useQuery ラッパ）を Vitest + MSW で、画面はサンプルレベルで Testing Library
- **E2E** は Playwright で golden path 1 本（画像付き item を作って一覧に出る）
- **各機能には参考テストを必ず添える**（コピー元として残す）。詳細は [`docs/template-plan.md`](./docs/template-plan.md) Step 8 参照

---

## ディレクトリ構成

トップレベル:

```
app-template/
├─ apps/
│  ├─ web/                 # React + TanStack Router + Vite
│  └─ api/                 # Hono on Workers (DDD レイヤ構成)
├─ packages/
│  └─ shared/              # zod schema / AppType / hc クライアント
├─ db/
│  ├─ migrations/
│  └─ schema.ts
├─ .claude/
│  ├─ commands/            # 標準コマンド + db-design / db-migrate / cf-deploy
│  └─ CLAUDE.md            # テンプレ固有の設計ルール
├─ .github/workflows/
├─ scripts/
└─ docs/
   ├─ template-plan.md     # 本テンプレの実装計画
   └─ decisions/           # ADR
```

### apps/api（Hono on Workers）— DDD レイヤ構成

「集約 + 1 集約 = 1 Repository + CQRS（read は queries に分離）」構成を採用する。

```
apps/api/
├─ src/
│  ├─ core/                # ドメイン知識を持たない技術コード（http / db / logging / errors / result 型 / auth ...）
│  │  ├─ http/             # Hono の env 型 / middleware / 共通レスポンス
│  │  ├─ db/               # D1 client / トランザクション抽象
│  │  ├─ logging/          # useLogger() スコープ
│  │  └─ errors/           # DomainError / Result<T, E>
│  ├─ modules/
│  │  └─ <feature>/        # 例: items, auth, members
│  │     ├─ <aggregate>/   # 集約名（例: items, authUsers）
│  │     │  ├─ domains/         # 集約のエンティティ・値オブジェクト・ドメインサービス
│  │     │  └─ repositories/    # 1 集約 = 1 Repository（永続化のみ）
│  │     ├─ queries/       # 読み取り専用クエリ（CQRS）
│  │     ├─ services/      # アプリケーションサービス（1 service = 1 use case、公開メソッドは execute のみ）
│  │     ├─ handlers/      # Hono ハンドラ（c.var.dbClient を直接参照しない、Deps を受け取るだけ）
│  │     ├─ schemas/       # zod スキーマ（packages/shared と整合）
│  │     └─ routes.ts      # OpenAPI ルート + DI ワイヤリング
│  ├─ index.ts             # app 構築 / AppType export
│  └─ envVariable.ts       # 環境変数 zod スキーマ
└─ wrangler.toml
```

レイヤごとの書き方:

**ドメインエンティティ** (`<aggregate>/domains/<name>.entity.ts`)

```ts
const FooEntity = z.object({ ... }).brand("Foo");
export type Foo = z.infer<typeof FooEntity>;
export const initializeFoo = (input: { ... }): Foo => FooEntity.parse({ ... });
export const reconstructFoo = (raw: { ... }): Foo => FooEntity.parse(raw);
export const updateFoo = (current: Foo, changes: Partial<Foo>): Foo => ({ ...current, ...changes });
```

**Repository** (`<aggregate>/repositories/<name>.repository.ts`)

```ts
export const fooRepository = (db: DBClientOrTx) => ({
  create: async (entity: Foo): Promise<void> => { ... },
  save: async (entity: Foo): Promise<void> => { ... },
});
export type FooRepository = ReturnType<typeof fooRepository>;
```

**Query** (`queries/<name>.query.ts`、読み取り専用 / CQRS の read 側)

```ts
export const fooQuery = (db: DBClientOrTx) => ({
  get: async ({ id }: { id: string }): Promise<Foo | null> => { ... },
});
export type FooQuery = ReturnType<typeof fooQuery>;
```

**Service** (`services/<name>.service.ts`、1 service = 1 use case)

```ts
type Deps = { query: FooQuery; repository: FooRepository };
export const buildFooService = ({ query, repository }: Deps) => ({
  execute: async (input: { ... }) => { ... },
});
export type FooService = ReturnType<typeof buildFooService>;
```

**Handler** (`handlers/<name>.handler.ts`、`c.var.dbClient` を直接参照しない)

```ts
type Deps = { fooService: FooService };
export const fooGetHandler = ({ fooService }: Deps): RouteHandler<...> => async (c) => {
  const result = await fooService.execute({ ... });
  return c.json(result, 200);
};
```

**Routes** (`routes.ts`、DI ワイヤリング)

```ts
app.openapi(fooGetRoute, (c, next) =>
  fooGetHandler({
    fooService: buildFooService({
      query: fooQuery(c.var.dbClient),
      repository: fooRepository(c.var.dbClient),
    }),
  })(c, next),
);
```

ルール:

- 集約間は **ID 経由で参照**。複数集約をまたぐトランザクションが必要なら service 層で組み立てる
- ドメインの状態遷移は **メソッドで表現**、プロパティの直接書き換え禁止
- DB レコードの型は **ORM 生成物**を参照する（手書きで列挙しない）
- handler は `Deps` のみ受け取り、`c.var.dbClient` / `c.var.storageClient` を直接触らない
- service / query / repository のモックは `src/__tests__/mocks/` に **生成関数**を置き、`beforeEach` で毎回生成する（ファイルスコープで使い回さない）
- 関数引数は **1 つ → positional / 2 つ以上 → named (object)**

### apps/web（React + TanStack Router）— package by feature + group routing

機能（feature）単位でディレクトリを切る **package by feature**。横断的な UI / hooks / utils は `shared/` にだけ置く。

```
apps/web/src/
├─ routes/                   # TanStack Router (file-based) のエントリ
│  ├─ __root.tsx
│  ├─ (public)/              # group routing: ログイン不要画面
│  │  ├─ login.tsx
│  │  └─ signup.tsx
│  ├─ (app)/                 # group routing: 認証済み画面
│  │  ├─ _layout.tsx         # AppShell + 認可ガード
│  │  ├─ index.tsx
│  │  └─ items/
│  │     ├─ index.tsx
│  │     └─ $itemId.tsx
│  └─ (admin)/               # 管理者専用などの別レイアウト
│     └─ _layout.tsx
├─ features/                 # package by feature: 機能ごとの内部実装
│  ├─ items/
│  │  ├─ components/         # その feature 専用 UI
│  │  ├─ hooks/              # useItemsQuery 等（hc + useQuery のラッパ）
│  │  ├─ api/                # client 呼び出しの薄い層
│  │  └─ index.ts            # 公開 API（このファイル経由でのみ参照させる）
│  └─ auth/
└─ shared/                   # feature をまたぐ共通コード
   ├─ designSystem/          # トークン / recipes / slot-recipes
   ├─ ui/                    # 共通コンポーネント
   ├─ hooks/
   └─ lib/
```

ルール:

- 画面は `routes/` のみ。ロジック / UI は `features/<feature>/` に閉じ込める
- `routes/(group)/` で **group routing** を使い、認証境界・レイアウト境界を URL に出さずに分離する
- feature 同士の直接 import は禁止。共有したくなったら `shared/` に昇格させる
- feature の公開境界は `features/<feature>/index.ts` に固定。深い相対 import を画面側からしない

UI トークンは `src/shared/designSystem/` に集約する（Vanilla CSS / Tailwind / Chakra など UI 基盤の選定は Phase 0 で確定）。

```
apps/web/src/shared/designSystem/
├─ tokens/                 # 物理トークン（colors / spacing / radii / fonts / breakpoints / z-index ...）
├─ semantic-tokens/        # 意味トークン（bg.subtle / fg.muted / border.default / shadow.card ...）
├─ recipes/                # 単一要素のバリアント（button / badge / input ...）
├─ slot-recipes/           # 複合コンポーネントのスロット別スタイル（card / dialog ...）
├─ text-styles.ts          # 見出し・本文等のタイポセット
├─ layer-styles.ts         # 背景 + 境界 + 影をひとまとめにした層スタイル
├─ animation-styles.ts     # 共通アニメーション
├─ keyframes.ts
├─ breakpoints.ts
├─ global-css.ts
└─ index.ts                # システム組み立て / Provider に渡すエントリ
```

ルール:

- **物理トークン（色番号 / スペーシング数値）を画面で直接使わない**。必ず semantic トークン経由で参照する
- ライト / ダーク等のテーマ切り替えは **semantic トークンの値だけが分岐**する形に保つ
- 1 度きりの hard-coded 色 / 余白を component に書かない（増えてきたら recipe / token に昇格）

---

## 撤退ライン

- D1 のクォータ / レイテンシ要件を超えた → Postgres + S3 互換ストレージへ移行
- Better Auth では賄えない要件（SAML / 既存 IdP 連携必須等）→ Clerk / Auth0 等の SaaS、または既存 IdP に切替
