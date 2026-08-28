# Plano de Implementação — Distributed Wagering Processor

Baseado no desafio: https://github.com/junglegaming/backend-challenge

---

## 0. Timebox e prioridades

Pontuação total = 100. Ordem de prioridade recomendada, do que mais pesa para o que menos pesa:

| Prioridade | Área | Pontos | Motivo |
|---|---|---|---|
| 1 | Correção financeira | 20 | Base de tudo — sem isso nada mais importa |
| 1 | Concorrência | 20 | Falha aqui é eliminatória (race → saldo negativo) |
| 2 | Idempotência | 15 | Falha eliminatória se for só em memória |
| 2 | Mensageria e falhas (inbox/outbox/DLQ) | 15 | Falha eliminatória se publicar evento antes do commit |
| 3 | Modelagem e arquitetura | 10 | Encapsulamento, portas, simplicidade |
| 3 | Testes | 10 | Precisa ser real (Postgres + LocalStack em container) |
| 4 | Observabilidade | 5 | Logs estruturados, métricas, health checks |
| 4 | Documentação | 5 | README + ARCHITECTURE.md |
| — | Autenticação | 0 | Não vale pontos — documentar decisão de não implementar ou implementar rápido com IdP (Keycloak/Zitadel) |

**Decisão recomendada sobre autenticação:** não implementar. Documentar em `ARCHITECTURE.md` a decisão, o desenho que seria adotado (OIDC via Keycloak, `AuthGuard` validando JWT do IdP) e deixar um `AuthGuard` no-op / `ProviderIdentityPort` como ponto de extensão explícito no código. Isso libera tempo para o que realmente pontua.

---

## 1. Stack e decisões técnicas de base

- **Runtime/test runner:** Bun 1.x
- **Linguagem:** TypeScript modo estrito
- **Framework:** NestJS
- **Banco:** PostgreSQL
- **Mensageria:** AWS SQS via LocalStack (FIFO queues)
- **ORM:** MikroORM (preferencial — Unit of Work, Identity Map, `EntityManager.transactional()`, `LockMode` nativo). TypeORM é aceito mas MikroORM se encaixa melhor com DDD explícito.
- **Orquestração local:** Docker Compose (Postgres + LocalStack + app, N instâncias)
- **Dinheiro:** `Decimal` (ex.: `decimal.js`) internamente, serializado sempre como string decimal com 2 casas fixas. Nunca `number`/`float`/`double`.

### Estratégia de concorrência (decidir e documentar)

Opções avaliadas:
1. **Optimistic locking com `version`** na wallet + retry limitado no application layer.
2. **Pessimistic locking** (`SELECT ... FOR UPDATE`) na wallet ao processar débito/crédito.
3. **Update atômico condicionado** (`UPDATE wallets SET balance = balance - X WHERE id = ? AND balance >= X`).

**Recomendação:** pessimistic locking (`FOR UPDATE`) na linha da wallet dentro da transação SQL que já cobre inbox + transaction + ledger + outbox. É mais simples de raciocinar sob alta concorrência com múltiplas instâncias do que optimistic + retry, e evita lost update sem lógica de retry adicional. Justificar trade-off (throughput vs simplicidade) no `ARCHITECTURE.md`. Manter `version` mesmo assim, para auditoria/otimismo em leituras.
**Nota operacional importante sobre RequestContext:** `MikroOrmModule.forRoot(config)` já cria o contexto por requisição HTTP automaticamente. Para workers/consumers SQS, o código precisa invocar `RequestContext.create(orm.em, async () => ...)` manualmente para evitar que múltiplas mensagens compartilhem o mesmo `EntityManager` e o Identity Map. Essa regra deverá ser explicitamente implementada no consumer do Dia 2.
### Estratégia de idempotência

- Chave primária/única `(consumerName, messageId)` na tabela de inbox — para consumo via SQS.
- Chave única `idempotencyKey` (default `{providerId}:{externalTransactionId}`) na tabela de `wager_transactions` — para entrada HTTP e para dedupe de negócio, independente do canal.
- `payloadHash` = SHA-256 de JSON canônico (chaves ordenadas) do subconjunto de campos de negócio (providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId). Documentar exatamente quais campos entram no hash.
- Comparar hash em replay: mesmo hash → devolve resultado original (`idempotentReplay: true`); hash diferente → conflito (409), não replay.

---

## 2. Modelo de domínio (ordem de implementação)

1. **`Money`** (value object) — escala fixa 2 casas, decimal string, validações de entrada, imutável.
2. **`Wallet`** (aggregate root) — `open`, `rehydrate`, `debit`, `credit`, invariantes de saldo não-negativo e moeda.
3. **`WalletLedgerEntry`** (imutável) — `create` valida `balanceBefore ± money === balanceAfter`.
4. **`WagerTransaction`** — máquina de estados (`PENDING → PENDING_REFERENCE → PROCESSED | REJECTED | FAILED`), regras por `kind`.
5. **`InboxMessage`** / **`OutboxMessage`** — dedupe de mensageria e publicação transacional.
6. **`IntegrationEvent<T>`** abstrata + subclasses concretas (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`).

### Máquina de estados de `WagerTransaction`

```
PENDING ──(referência ok)──► PROCESSED
PENDING ──(sem referência)──► PENDING_REFERENCE ──(resolvida)──► PROCESSED
PENDING_REFERENCE ──(TTL/tentativas esgotadas)──► REJECTED
PENDING ──(regra de negócio violada)──► REJECTED
PENDING ──(erro permanente infra)──► FAILED
```
Todas as transições a partir de estado terminal (`PROCESSED`, `REJECTED`, `FAILED`) lançam `InvalidTransactionStateError`.

### Taxonomia de `failureCode` (definir e documentar)

Sugestão mínima:
- `INSUFFICIENT_BALANCE`
- `CURRENCY_MISMATCH`
- `REFERENCE_NOT_FOUND` (após esgotar tentativas de `PENDING_REFERENCE`)
- `REFERENCE_ALREADY_REVERSED`
- `REFERENCE_TYPE_MISMATCH` (ex.: `REFUND` referenciando algo que não é `BET`)
- `REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` (distinto de `INSUFFICIENT_BALANCE`)
- `IDEMPOTENCY_PAYLOAD_CONFLICT`
- `INVALID_MONEY_FORMAT`

---

## 3. Schema de banco (constraints no nível do schema, não só aplicação)

Tabelas mínimas:
- `wallets` — unique `(player_id, currency)`; `balance_amount` como `numeric(x,2)`; `check (balance_amount >= 0)`; `version int`.
- `wager_transactions` — unique `idempotency_key`; unique `(provider_id, external_transaction_id)`; índice em `(provider_id, reference_external_transaction_id)` para resolução de referência; check de campos obrigatórios por `kind`.
- `wallet_ledger_entries` — imutável (sem coluna de update relevante; considerar trigger que bloqueia `UPDATE`/`DELETE`); unique `(transaction_id, wallet_id)` (no máximo um lançamento por wallet por transação); check `balance_after = balance_before ± amount` (se viável via constraint, senão validado na aplicação e reforçado em teste de integração).
- `inbox_messages` — unique `(consumer_name, message_id)`.
- `outbox_messages` — índice em `(published_at, next_attempt_at)` para o worker de publicação; coluna `attempts`.

Migrations: versionadas e reversíveis (up/down) desde o commit inicial.

---

## 4. Camadas / estrutura de pastas (sugestão DDD)

```
src/
  domain/
    money/
    wallet/
    wager-transaction/
    ledger/
    events/
    ports/            # interfaces (ex.: ProviderIdentityPort, EventPublisherPort)
  application/
    use-cases/
      submit-wager-transaction/
      resolve-pending-reference/
      get-wallet/
      list-ledger/
      reconcile-wallet/
  infrastructure/
    persistence/
      mikro-orm/ (entities, migrations, repositories)
    messaging/
      sqs/ (consumer, outbox publisher worker)
    http/
      controllers, dtos, guards (AuthGuard no-op)
    observability/
      logger, metrics
  main.ts
```

Regra chave: **o mesmo use case** (`SubmitWagerTransactionUseCase`) é chamado tanto pelo controller HTTP quanto pelo consumer SQS.

---

## 5. Fluxo transacional (o núcleo do desafio)

Dentro de **uma única transação SQL**:
1. (se origem SQS) inserir `InboxMessage` — se já existe, retornar cedo com resultado já processado (buscar `WagerTransaction` por `idempotencyKey`).
2. Verificar `idempotencyKey`: se existe com mesmo `payloadHash` → replay do resultado; se existe com hash diferente → conflito; se não existe → seguir.
3. Lock pessimista na `Wallet` (`FOR UPDATE`) por `walletId`.
4. Resolver referência se `kind` exigir (`REFUND`/`ROLLBACK`); se ausente → persistir `PENDING_REFERENCE` e commitar (sem tocar saldo).
5. Aplicar regra de negócio (`debit`/`credit`/nenhum efeito para `LOSS`); validar saldo suficiente / não-negatividade da reversão.
6. Criar `WalletLedgerEntry` (se houver efeito no saldo).
7. Atualizar `Wallet.balance` e incrementar `version`.
8. Marcar `WagerTransaction` como `PROCESSED`/`REJECTED`.
9. Enfileirar `OutboxMessage` (evento correspondente).
10. Commit.
11. (se origem SQS) `ack` **somente depois do commit**.

Worker separado de outbox faz `SELECT ... FOR UPDATE SKIP LOCKED` (ou equivalente) para publicar com múltiplos publishers concorrentes sem duplicar indefinidamente nem perder mensagens.

---

## 6. Ordem de implementação sugerida (passos concretos)

1. Setup: Docker Compose (Postgres, LocalStack com filas FIFO), scaffold NestJS + Bun, config MikroORM.
2. Migrations iniciais: `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, `outbox_messages`.
3. Domínio: `Money` + testes unitários (escala, erros de entrada, moeda).
4. Domínio: `Wallet`, `WalletLedgerEntry`, `WagerTransaction` (máquina de estados) + testes unitários.
5. Use case `CreateWallet` (com `OPENING` transacional) + endpoint `POST /wallets`.
6. Use case `SubmitWagerTransaction` cobrindo `BET`/`WIN`/`LOSS` (caminho feliz, sem referência) + endpoint HTTP com `Idempotency-Key`.
7. Idempotência: dedupe por `idempotencyKey` + `payloadHash`, testes de conflito e replay.
8. Concorrência: lock pessimista na wallet, teste de carga com 2 apostas simultâneas de 80 sobre saldo 100 (cenário obrigatório da seção 8).
9. `REFUND`/`ROLLBACK` com resolução de referência + `PENDING_REFERENCE` + worker de retry com backoff.
10. Outbox: `IntegrationEvent` + subclasses, worker de publicação, teste com múltiplos publishers.
11. Consumer SQS: inbox, dedupe, ack pós-commit, distinção erro de negócio/transitório/permanente, DLQ.
12. Endpoints restantes: `GET /wallets/:id`, `GET /wallets/:id/ledger` (cursor opaco), `GET /wagering/transactions/:id`, `GET /providers/:id/wagering/transactions/:externalId`.
13. Reconciliação: `POST /wallets/:id/reconciliation` (recalcula saldo pelo ledger, compara, loga divergência).
14. Health checks: `/health/live`, `/health/ready` (sem auth).
15. Observabilidade: logger estruturado JSON, métricas (contadores/histogramas descritos na seção 12 do desafio).
16. Testes de integração real (containers): migrations/constraints, atomicidade, inbox/redelivery, publishers concorrentes, retry/DLQ, restart.
17. Testes de concorrência real (paralelismo de verdade): os 8 itens da seção 13.
18. `ARCHITECTURE.md` e `README.md`.
19. (Opcional) teste de carga `bun run test:load` com métricas de throughput/p50/p95/p99.
20. (Opcional) decidir e implementar autenticação via IdP, se sobrar tempo — só depois de tudo acima estar sólido.

---

## 7. Checklist de "falhas eliminatórias" a revisar antes de entregar

- [ ] Nenhum `number`/`float`/`double` usado para dinheiro em nenhum lugar do código.
- [ ] Cenário de 2 apostas simultâneas nunca deixa saldo negativo, mesmo sob repetição do teste.
- [ ] Nenhum débito/crédito duplicado sob retry ou reentrega.
- [ ] Idempotência funciona mesmo reiniciando o processo (não depende de cache em memória).
- [ ] Solução correta com ≥3 instâncias rodando ao mesmo tempo.
- [ ] Evento de integração nunca é publicado antes do commit da transação financeira.
- [ ] Todo lançamento de ledger é auditável e imutável (sem update/delete).
- [ ] Testes de integração usam Postgres e LocalStack reais em container, não mocks totais.

---

## 8. Estrutura sugerida do `ARCHITECTURE.md` (a escrever ao final)

1. Visão geral e decisões de escopo (ex.: moeda única BRL).
2. Modelagem de `Money` e por que (biblioteca decimal escolhida).
3. Estratégia de concorrência escolhida e por quê (trade-offs vs alternativas).
4. Estratégia de idempotência (chave, hash, canonicalização).
5. Desenho de inbox/outbox e worker de publicação.
6. Máquina de estados de `WagerTransaction` e taxonomia de `failureCode`.
7. Schema e constraints (com trecho do DDL relevante).
8. Decisão sobre autenticação (implementada ou não) e ponto de extensão.
9. Limitações conhecidas e o que seria feito com mais tempo.
