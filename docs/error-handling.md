# Error Handling Guide

このテンプレで採用するバックエンド（`apps/api`）のエラーハンドリング方針。
要点は [README §「8. エラーハンドリング」](../README.md#8-エラーハンドリングresult-型--problem-レスポンス) も参照。

---

## 目的

1. **ユーザー体験**: 予期した失敗は 4xx / 409 などの Problem 応答で返し、クライアントがリトライや UI 制御を判断できるようにする
2. **監視 / SLO**: 予期しない障害だけを Sentry / メトリクスで監視し、ノイズの少ないアラートを保つ
3. **デバッグ効率**: エラーがどう生じたかを `details` で残し、調査コストを下げる

---

## タクソノミー

| 種別 | 想定レイヤ | 役割 | 代表的な `details` |
| --- | --- | --- | --- |
| `DomainError<Reason>` | service / domain | 業務ルールや状態遷移に基づく予期した失敗。Result で呼び出し元に返す | `{ meta: { itemId } }` |
| `InfraError<Reason>` | repository / gateway | DB / 外部 API が返す決定的な失敗（ユニーク制約、リソース不足など）をビジネス文脈へ写像 | `{ meta: { id } }` |
| `UnexpectedError` | 全レイヤ | 説明不能・復旧に人手が必要な障害。`throw` して `app.onError` で捕捉し Sentry へ | 運用者の調査に使える情報を `details` に格納 |

共通ルール:

- 予期した失敗は **必ず Result で返す**。`throw` してよいのは `UnexpectedError` のみ
- `details` は `{ origin: ErrorOrigin, meta?: Record<string, unknown>, traceId?: string }` の形
  - `DomainError` / `InfraError` は `origin` を自動付与するので、呼び出し元は `meta`（ID・入力抜粋）と必要に応じて `traceId` を設定
- `reason` 文字列は呼び出し関数の近くで `const ItemNotFound = "items.not_found" as const;` のように定義し、戻り値の Result 型から union を**暗黙推論**させる（OpenAPI Problem code とは区別する）
- `ErrorOrigin = "domain" | "application" | "infra" | "interface"`

> 注: `as const` は値リテラルを保つための表現で、ここで言う「型アサーション禁止」（README §1）には含まれない。型を別物に偽る `as` / `as unknown as` / `!` を禁止しているのが規約の意図。

---

## レイヤ別パターン

### 1. ドメイン層（service / entity）

- シグネチャは `Result<Payload, DomainError<Reason>>` または `Promise<Result<Payload, DomainError<Reason> | InfraError<Reason>>>`
- バリデーション / 状態遷移の失敗は `DomainError` で返す
- 期待外の例外は `throw new UnexpectedError(...)`

```ts
import { type Result, success, err } from "@/core/result";
import { DomainError, UnexpectedError } from "@/core/errors";

const ItemPublished = "items.published" as const;

export const updateItem = (item: Item, input: UpdateItemInput) => {
  if (item.publicationStatus !== "draft") {
    return err(
      new DomainError(ItemPublished, {
        meta: { itemId: item.id, status: item.publicationStatus },
      }),
    );
  }

  const updated = applyChanges(item, input);
  if (!updated.success) {
    throw new UnexpectedError("item の更新に失敗しました", "domain", {
      details: { itemId: item.id, errors: updated.error },
    });
  }
  return success(updated.value);
};
```

ポイント:

- Result 型から union を暗黙推論させる（明示しない）
- `details.meta` に関連 ID や入力抜粋を入れる
- ドメインエンティティ内の純粋関数は同期的に Result を返す

### 2. インフラ層（repository / gateway）

- ビジネス的に説明できる DB / API 失敗は `InfraError` にマッピングして Result を返す
- ノイズな障害（ネットワーク断・認証切れなど）は即座に `UnexpectedError` で `throw`

```ts
import { type Result, success, err } from "@/core/result";
import { InfraError, UnexpectedError } from "@/core/errors";

const UniqueViolation = "infra.d1.unique_violation" as const;

export async function saveItem(tx: DBClientOrTx, data: ItemRecord) {
  try {
    const record = await tx.insert(items).values(data).returning();
    return success(record);
  } catch (e) {
    if (isUniqueViolation(e)) {
      return err(
        new InfraError(UniqueViolation, { meta: { id: data.id } }, { cause: e }),
      );
    }
    throw new UnexpectedError("d1.unknown", "infra", {
      cause: e,
      details: { meta: { repository: "item.save" } },
    });
  }
}
```

### 3. ハンドラ層（Hono）

- Result を受け取り、`switch (error.reason)` で Problem に振る
- `buildBadRequestProblemSchema(codes)` を使って **OpenAPI スキーマと実装を同期**
- `ErrorCode` はステータスごとにグループ化
- `default: return error.reason satisfies never;` で網羅性チェック
- repository / トランザクション内では `null` を返さず、その場で `err(new DomainError/InfraError)` に変換して表層に伝える

```ts
import {
  buildBadRequestProblemSchema,
  notFoundProblem,
} from "@/core/http/schemas/error.schema";
import { DomainError, UnexpectedError } from "@/core/errors";
import { err, success } from "@/core/result";

const ErrorCode = {
  400: { ItemPublished: "items.published" },
  404: { ItemNotFound: "items.not_found" },
} as const;

const { BadRequestProblemSchema, badRequestProblem } =
  buildBadRequestProblemSchema([ErrorCode[400].ItemPublished]);

export const itemPatchHandler =
  ({ itemRepo }: Deps): RouteHandler<typeof itemPatchRoute> =>
  async (c) => {
    const dbClient = c.var.dbClient;

    const result = await runResultTransaction(dbClient, async (tx) => {
      const id = c.req.param("id");
      const existing = await itemRepo(tx).findById(id);
      if (existing === null) {
        return err(
          new DomainError(ErrorCode[404].ItemNotFound, { meta: { itemId: id } }),
        );
      }

      const updateResult = updateItem(existing, c.req.valid("json"));
      if (!updateResult.ok) return updateResult;

      await itemRepo(tx).save(updateResult.value);

      const after = await itemRepo(tx).findById(updateResult.value.id);
      if (after === null) {
        throw new UnexpectedError("更新後の item が見つかりません", "infra", {
          details: { meta: { itemId: existing.id } },
        });
      }
      return success(after);
    });

    if (!result.ok) {
      const error = result.error;
      switch (error.reason) {
        case "items.not_found":
          return c.json(
            notFoundProblem({
              title: "item が見つかりません",
              instance: c.req.path,
              traceId: c.var.traceId,
            }),
            404,
          );
        case "items.published":
          return c.json(
            badRequestProblem({
              title: "公開済みの item は更新できません",
              code: ErrorCode[400].ItemPublished,
              detail: "更新するにはまず非公開にしてください",
              instance: c.req.path,
              traceId: c.var.traceId,
            }),
            400,
          );
        default:
          return error.reason satisfies never;
      }
    }

    return c.json({ item: result.value }, 200);
  };
```

ポイント:

- `buildBadRequestProblemSchema` は指定したコード一覧から型安全な Problem スキーマと `problem(...)` ビルダを生成する
- `default: return error.reason satisfies never;` で switch の網羅性を型レベルで保証
- 401 / 403 / 404 / 500 の標準的なものは `unauthorizedProblem` / `forbiddenProblem` / `notFoundProblem` / `internalServerErrorProblem` を再利用

### 4. トランザクションユーティリティ `runResultTransaction`

D1 のトランザクション内で `return err(...)` してもコミットされてしまうため、`core/db/runResultTransaction.ts` を経由して **Result とロールバックを両立**させる。

使い方の指針:

1. **コールバックは Result を返す**: `runResultTransaction(dbClient, async (tx): Promise<Result<Payload, ExpectedError>> => { ... })`。ジェネリクスはコールバックから推論されるので明示しない
2. **想定外は throw**: 想定外エラーは従来どおり `throw new UnexpectedError(...)`。`runResultTransaction` は `ExpectedError` を包んでロールバックし、`UnexpectedError` は透過的に伝播させる
3. **トランザクション内の読み書きは必ず `tx`**: 途中で `dbClient` を直接使うとロールバック対象外の I/O になるため禁止

### 5. グローバル境界（`app.onError`）

- `ExpectedError` が境界まで来た場合は **設計漏れ**として扱い、`UnexpectedError` でラップして Sentry に送る
- それ以外は `Sentry.captureException(err)` を呼び、`origin` と `details` をタグに付与する

```ts
app.onError((e, c) => {
  if (isExpectedError(e)) {
    const unexpected = new UnexpectedError(
      "handler.unhandled_expected_error",
      "interface",
      { cause: e },
    );
    Sentry.captureException(unexpected);
    return c.json(internalServerErrorProblem({ instance: c.req.path }), 500);
  }
  Sentry.captureException(e);
  return c.json(internalServerErrorProblem({ instance: c.req.path }), 500);
});
```

---

## チェックリスト

### ドメイン層

- [ ] 戻り値が `Result<...>` または `Promise<Result<...>>` になっているか
- [ ] `reason` を局所定数として定義し、Result から literal union が推論されるか
- [ ] `details.meta` に運用者の調査に使える情報を入れたか

### インフラ層

- [ ] DB / SDK のエラーを `InfraError` に分類し、想定外は `UnexpectedError` に振り分けたか
- [ ] `details.meta` を埋めたか
- [ ] repository / トランザクション内で `null` を素のまま返していないか

### ハンドラ層

- [ ] `buildXxxProblemSchema` で型安全な Problem スキーマを生成しているか
- [ ] `ErrorCode` をステータスごとにグループ化しているか
- [ ] `default: return error.reason satisfies never;` で網羅性チェックしているか
- [ ] OpenAPI の `responses` にスキーマを渡し、実装と同期しているか

### グローバル境界

- [ ] `app.onError` で `isExpectedError(err)` をチェックし、バブルした `ExpectedError` を Sentry に通知できているか
