import { PasswordInput, Spinner, StatusMessage, TextInput } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import { type SpawnProgress, runSpawn } from "../commands/spawn.js";
import { PROVIDER_DEFAULTS, buildProviderConfig } from "../config/models.js";
import type { Tenant } from "../types/index.js";
import { LOBSTER } from "./theme.js";

type Step =
  | "enter-base-url"
  | "enter-model"
  | "enter-model-name"
  | "enter-context-window"
  | "enter-max-tokens"
  | "enter-api-key"
  | "spawning"
  | "done";

interface Props {
  name: string;
}

export function SpawnFlow({ name }: Props) {
  const { exit } = useApp();

  const [step, setStep] = useState<Step>("enter-base-url");
  const [baseUrl, setBaseUrl] = useState(PROVIDER_DEFAULTS.baseUrl);
  const [model, setModel] = useState(PROVIDER_DEFAULTS.model);
  const [modelName, setModelName] = useState(PROVIDER_DEFAULTS.modelName);
  const [contextWindow, setContextWindow] = useState(PROVIDER_DEFAULTS.contextWindow);
  const [maxTokens, setMaxTokens] = useState(PROVIDER_DEFAULTS.maxTokens);
  const [progress, setProgress] = useState<SpawnProgress | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleBaseUrlSubmit(value: string) {
    setBaseUrl(value || PROVIDER_DEFAULTS.baseUrl);
    setStep("enter-model");
  }

  function handleModelSubmit(value: string) {
    setModel(value || PROVIDER_DEFAULTS.model);
    setStep("enter-model-name");
  }

  function handleModelNameSubmit(value: string) {
    setModelName(value || PROVIDER_DEFAULTS.modelName);
    setStep("enter-context-window");
  }

  function handleContextWindowSubmit(value: string) {
    const parsed = Number.parseInt(value, 10);
    setContextWindow(parsed > 0 ? parsed : PROVIDER_DEFAULTS.contextWindow);
    setStep("enter-max-tokens");
  }

  function handleMaxTokensSubmit(value: string) {
    const parsed = Number.parseInt(value, 10);
    setMaxTokens(parsed > 0 ? parsed : PROVIDER_DEFAULTS.maxTokens);
    setStep("enter-api-key");
  }

  function handleApiKeySubmit(apiKey: string) {
    if (!apiKey.trim()) return;

    const override = buildProviderConfig({
      baseUrl,
      model,
      modelName,
      contextWindow,
      maxTokens,
      apiKey: apiKey.trim(),
    });
    setStep("spawning");

    runSpawn(name, (p) => setProgress(p), { openclawOverride: override }).then(
      (result) => {
        if (result.isOk()) {
          setTenant(result.value);
        } else {
          setError(result.error.message);
        }
        setStep("done");
      },
    );
  }

  useEffect(() => {
    if (step === "done") {
      exit();
    }
  }, [step, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>
        {LOBSTER} lobsterd spawn {name}
      </Text>

      {step === "enter-base-url" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Base URL:</Text>
            <TextInput
              defaultValue={PROVIDER_DEFAULTS.baseUrl}
              onSubmit={handleBaseUrlSubmit}
            />
          </Box>
          <Text dimColor>OpenAI-compatible endpoint (press Enter for default)</Text>
        </Box>
      )}

      {step === "enter-model" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Model ID:</Text>
            <TextInput
              defaultValue={PROVIDER_DEFAULTS.model}
              onSubmit={handleModelSubmit}
            />
          </Box>
          <Text dimColor>Model identifier at the provider</Text>
        </Box>
      )}

      {step === "enter-model-name" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Model name:</Text>
            <TextInput
              defaultValue={PROVIDER_DEFAULTS.modelName}
              onSubmit={handleModelNameSubmit}
            />
          </Box>
          <Text dimColor>Human-readable display name</Text>
        </Box>
      )}

      {step === "enter-context-window" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Context window:</Text>
            <TextInput
              defaultValue={String(PROVIDER_DEFAULTS.contextWindow)}
              onSubmit={handleContextWindowSubmit}
            />
          </Box>
          <Text dimColor>Max input tokens</Text>
        </Box>
      )}

      {step === "enter-max-tokens" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Max output tokens:</Text>
            <TextInput
              defaultValue={String(PROVIDER_DEFAULTS.maxTokens)}
              onSubmit={handleMaxTokensSubmit}
            />
          </Box>
          <Text dimColor>Max tokens per response</Text>
        </Box>
      )}

      {step === "enter-api-key" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>API key:</Text>
            <PasswordInput
              placeholder="Enter your API key"
              onSubmit={handleApiKeySubmit}
            />
          </Box>
        </Box>
      )}

      {step === "spawning" && (
        <Box flexDirection="column" marginTop={1}>
          <Spinner
            label={
              progress
                ? `[${progress.step}] ${progress.detail}`
                : "Starting..."
            }
          />
        </Box>
      )}

      {step === "done" && error && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}

      {step === "done" && tenant && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="success">
            Tenant "{tenant.name}" spawned successfully
          </StatusMessage>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            <Text>
              CID: <Text bold>{tenant.cid}</Text>
            </Text>
            <Text>
              IP: <Text bold>{tenant.ipAddress}</Text>
            </Text>
            <Text>
              Port: <Text bold>{tenant.gatewayPort}</Text>
            </Text>
            <Text>
              PID: <Text bold>{tenant.vmPid}</Text>
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
