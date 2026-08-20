import {
  PyAgentSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ModelCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makePyAgentAdapter } from "../Layers/PyAgentAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodePyAgentSettings = Schema.decodeSync(PyAgentSettings);
const DRIVER_KIND = ProviderDriverKind.make("pyagent");

const PYAGENT_PRESENTATION = {
  displayName: "Py Agent (Local)",
  badgeLabel: "Local",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const PYAGENT_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "effort",
      label: "Reasoning",
      options: [
        { value: "off", label: "Off" },
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium", isDefault: true },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ],
    }),
  ],
});

const PYAGENT_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "local-model",
    name: "Local LLM (llama.cpp / Cloud)",
    isCustom: false,
    capabilities: PYAGENT_MODEL_CAPABILITIES,
  },
];

const UPDATE = makeStaticProviderMaintenanceResolver(
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
  }),
);

export type PyAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export function buildPyAgentProviderSnapshot(
  effectiveConfig: PyAgentSettings,
  displayName?: string,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    return buildServerProvider({
      presentation: {
        ...PYAGENT_PRESENTATION,
        ...(displayName ? { displayName } : {}),
      },
      enabled: effectiveConfig.enabled,
      checkedAt,
      models: PYAGENT_BUILT_IN_MODELS,
      probe: {
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        message: "Py-Agent bridge active",
      },
    });
  });
}

export const PyAgentDriver: ProviderDriver<PyAgentSettings, PyAgentDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Py Agent (Local)",
    supportsMultipleInstances: true,
  },
  configSchema: PyAgentSettings,
  defaultConfig: (): PyAgentSettings => decodePyAgentSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PyAgentSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath || "python3",
        env: processEnv,
      });

      const serverSettings = yield* ServerSettingsService;
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);

      const checkProvider = buildPyAgentProviderSnapshot(effectiveConfig, displayName).pipe(
        Effect.map(stampIdentity),
      );

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PyAgentSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build PyAgent snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      const adapter = yield* makePyAgentAdapter(effectiveConfig, {
        environment: processEnv,
        instanceId,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
      } satisfies ProviderInstance;
    }),
};
