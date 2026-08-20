import { type PyAgentSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as path from "path";
import * as os from "os";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const PYAGENT_DRIVER_KIND = ProviderDriverKind.make("pyagent");

type PyAgentAcpRuntimeSettings = Pick<PyAgentSettings, "binaryPath" | "bridgePath">;

interface PyAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly pyagentSettings: PyAgentAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildPyAgentAcpSpawnInput(
  pyagentSettings: PyAgentAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const defaultBridge = path.join(os.homedir(), ".config/py-agent/plugins/t3code/bridge.py");
  const bridgeScript = pyagentSettings?.bridgePath || defaultBridge;
  const pythonBin = pyagentSettings?.binaryPath || "python3";

  return {
    command: pythonBin,
    args: [bridgeScript],
    cwd,
    env: {
      ...environment,
      AI_WORKSPACE_PATH: cwd,
    },
  };
}

export const makePyAgentAcpRuntime = (
  input: PyAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildPyAgentAcpSpawnInput(input.pyagentSettings, input.cwd, input.environment),
        authMethodId: "local",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolvePyAgentBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "local-model";
  return normalizeModelSlug(base, PYAGENT_DRIVER_KIND) ?? "local-model";
}
