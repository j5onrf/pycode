import {
  type PyAgentSettings,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makePyAgentAcpRuntime } from "../acp/PyAgentAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("pyagent");

interface PyAgentSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  activeAssistantItemId: string | undefined;
  promptsInFlight: number;
  stopped: boolean;
}

export function makePyAgentAdapter(
  pyagentSettings: PyAgentSettings,
  options?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly instanceId?: typeof ProviderInstanceId.Type;
  },
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pyagent");
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;

    const sessions = new Map<ThreadId, PyAgentSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate runtime identifier.",
            cause,
          }),
      ),
    );

    const makeEventStamp = () =>
      Effect.gen(function* () {
        const eventId = (yield* randomUUIDv4) as unknown as typeof EventId.Type;
        const createdAt = yield* nowIso;
        return { eventId, createdAt };
      });

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const stopSessionInternal = (ctx: PyAgentSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession = (input: {
      readonly threadId: ThreadId;
      readonly cwd?: string;
      readonly provider?: typeof ProviderDriverKind.Type;
      readonly runtimeMode: RuntimeMode;
      readonly modelSelection?: { readonly instanceId: string; readonly model: string };
      readonly resumeCursor?: unknown;
    }) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const acp = yield* makePyAgentAcpRuntime({
            pyagentSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            clientInfo: { name: "t3-code", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );

          yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
              ),
            );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: "local-model",
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          };

          const ctx: PyAgentSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            activeTurnId: undefined,
            activeAssistantItemId: undefined,
            promptsInFlight: 0,
            stopped: false,
          };

          // Stream ACP live notifications to T3 Code UI
          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "AssistantItemStarted":
                    ctx.activeAssistantItemId = event.itemId;
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    ctx.activeAssistantItemId = undefined;
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    const isThought =
                      typeof event.rawPayload === "object" &&
                      event.rawPayload !== null &&
                      (event.rawPayload as any).update?.sessionUpdate === "agent_thought_chunk";

                    const itemId = event.itemId ?? ctx.activeAssistantItemId;
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        streamKind: isThought ? "thought" : "assistant_text",
                        ...(itemId ? { itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process PyAgent runtime notification.", { cause }),
            ),
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: undefined },
          });

          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Py-Agent bridge active" },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn = (input: {
      readonly threadId: ThreadId;
      readonly input?: string;
      readonly attachments?: ReadonlyArray<unknown>;
    }) =>
      Effect.gen(function* () {
        const ctx = sessions.get(input.threadId);
        if (!ctx || ctx.stopped) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId: input.threadId,
          });
        }

        const turnId = (yield* randomUUIDv4) as unknown as TurnId;
        const assistantItemId = `msg-${(yield* randomUUIDv4).slice(0, 8)}`;
        ctx.activeTurnId = turnId;
        ctx.activeAssistantItemId = assistantItemId;
        ctx.promptsInFlight += 1;

        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: "local-model" },
        });

        // Immediately open the assistant streaming bubble in the UI
        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            itemId: assistantItemId,
            lifecycle: "item.started",
          }),
        );

        const promptText = input.input?.trim() || "Hello";

        const result = yield* ctx.acp
          .prompt({
            prompt: [{ type: "text", text: promptText }],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );

        // Mark the assistant bubble completed
        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            itemId: assistantItemId,
            lifecycle: "item.completed",
          }),
        );

        ctx.activeAssistantItemId = undefined;
        ctx.promptsInFlight = Math.max(0, ctx.promptsInFlight - 1);

        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (ctx) {
          yield* Effect.ignore(ctx.acp.cancel);
        }
      });

    const stopSession = (threadId: ThreadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession = (threadId: ThreadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll = () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      readThread: (threadId: ThreadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: (threadId: ThreadId) => Effect.succeed({ threadId, turns: [] }),
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    };
  });
}
