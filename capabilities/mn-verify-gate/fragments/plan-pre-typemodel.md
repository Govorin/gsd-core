<type_model_before_implementation>
**Before any task that writes behaviour, the plan must state the types that behaviour moves through.**

In this codebase the type IS the specification: an `EitherAsync<OrderError, Order>` says what can fail and what comes back; a `Brand<string, 'OrderId'>` says which ids may be passed where; a closed `ErrorCode` const says which failures exist at all. Code written before those decisions does not merely need refactoring later — it encodes a different specification, and the compiler will defend the wrong one.

The lint layer already enforces the SHAPE of these decisions (`no-raw-primitive-domain-types`, `no-unbranded-id-in-port`, `error-code-file-naming`, `zod-enum-const-object`, `no-inline-error-type`, and ~60 more). It cannot make the decisions, and it fires only once code exists — by then the choice was made by whoever typed first. That is the gap this section fills: the decisions, in the plan, before the tasks that depend on them.

## What the plan must state

State only what this phase actually introduces. A phase that adds a screen over existing types declares nothing here and says so in one line — an empty section is a legitimate answer, an absent one is not.

**1. Domain vocabulary — the nouns and their identity**

| Type | Shape | Branded? | Where it lives |
|---|---|---|---|
| `OrderId` | `Brand<string, 'OrderId'>` | yes | `libs/trade/types/src/order/order-id.ts` |
| `Order` | `{ id: OrderId; status: OrderStatus; … }` | — | `libs/trade/types/src/order/order.ts` |

A raw `string` id crossing a port boundary is the defect `no-unbranded-id-in-port` exists to catch; deciding it here means the rule never has to fire.

**2. The failure set — closed, named, and complete before the first `left()`**

Every service this phase touches gets one discriminated union and one `*.error-code.ts`:

```ts
export const OrderErrorCode = {
  OrderNotFound: 'OrderNotFound',
  OrderAlreadyFilled: 'OrderAlreadyFilled',
} as const;
export type OrderErrorCode = (typeof OrderErrorCode)[keyof typeof OrderErrorCode];
```

List the codes in the plan. A code invented mid-implementation is a failure mode nobody decided should exist, and every caller's `match(...).exhaustive()` silently widens to accommodate it.

**3. Port signatures — the exact return types crossing a plan boundary**

```
OrderPort.findPending(): EitherAsync<OrderError, Order[]>
OrderPort.fill(id: OrderId): EitherAsync<OrderError, Order>
```

Write them as they will compile. This is the concrete failure DESIGN.md was added for: wave 2's plan is written before wave 1's code exists, so it calls `Promise<Order|null>` against an `EitherAsync` port; both plans verify green in isolation and the mismatch lands on the pre-commit typecheck with both commits already in history.

**Where to put them:** if this phase writes a `{phase}-DESIGN.md`, these signatures belong under its `## Contracts` heading — `workflow.contract_drift` reads that heading and only that one, and compares each declaration against the shipped code at verify:pre. Signatures written anywhere else are prose that nothing checks. Without a DESIGN.md, put them in the plan that introduces the port and repeat the exact text in each consuming plan's `<interfaces>` block.

**4. Schema ownership — which Zod schema is authoritative, and what is derived from it**

Name the schema, then state that the DTO type is `z.infer` of it, never a hand-written twin. Two declarations of the same shape drift; the only question worth answering in the plan is which one is the source.

**5. State that the type cannot hold**

If a value is legal in the type but illegal in the domain — an `Order` that is `filled` with no `filledAt`, a `Price` in the wrong currency — say so and say what carries the constraint: a phantom parameter (`Order<Filled>`), a smart constructor, or a `.refine()` on the schema. "The service checks it" is the answer that produces the bug this section is here to prevent, because a check is a thing that can be forgotten at one of its call sites.

## Ordering that follows from this

Types, error codes and schemas land in the phase's **first wave**, ahead of the services and controllers that consume them. A later wave adding a field to a shared type is a signal the model was decided too late — not fatal, but worth a line in the deviation notes so the next phase's split accounts for it.

## What does not belong here

Implementation. This section fixes the contract; the tasks fill it in. If a decision cannot be made without writing code first, that is a spike, and the plan should say so rather than guessing at a signature nobody has tried.
</type_model_before_implementation>
