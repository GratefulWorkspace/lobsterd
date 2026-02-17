import { ConfirmInput, Spinner, StatusMessage, TextInput } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useEffect, useState } from "react";
import type {
  InitOpts,
  InitResult,
  PreflightResult,
} from "../commands/init.js";
import { runInit } from "../commands/init.js";
import type { LobsterdConfig } from "../types/index.js";
import { LOBSTER } from "./theme.js";

type Step = "domain" | "confirm" | "running" | "done";

interface Props {
  preflight: PreflightResult;
  config: LobsterdConfig;
}

export function InitFlow({ preflight: pre, config }: Props) {
  const { exit } = useApp();
  const hasMissing = Object.values(pre.missing).some(Boolean);

  const [step, setStep] = useState<Step>("domain");
  const [domain, setDomain] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<InitResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build the list of missing deps for display
  const missingNames: string[] = [];
  if (pre.missing.firecracker) {
    missingNames.push("Firecracker + Jailer");
  }
  if (pre.missing.kernel) {
    missingNames.push("Kernel");
  }
  if (pre.missing.rootfs) {
    missingNames.push("Rootfs (Alpine, built from source)");
  }
  if (pre.missing.caddy) {
    const via = pre.caddyPackageManager
      ? ` via ${pre.caddyPackageManager}`
      : "";
    missingNames.push(`Caddy${via}`);
  }

  function handleDomainSubmit(value: string) {
    setDomain(value || undefined);
    if (hasMissing) {
      setStep("confirm");
    } else {
      setStep("running");
    }
  }

  function handleConfirm() {
    setStep("running");
  }

  function handleCancel() {
    exit();
  }

  useEffect(() => {
    if (step !== "running") {
      return;
    }

    const opts: InitOpts = {
      domain,
      install: { ...pre.missing },
    };

    runInit(config, opts).then((r) => {
      if (r.isOk()) {
        setResult(r.value);
        setStep("done");
      } else {
        setError(r.error.message);
        setStep("done");
      }
    });
  }, [step, config, domain, pre.missing]);

  useEffect(() => {
    if (step === "done") {
      exit();
    }
  }, [step, exit]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>{LOBSTER} lobsterd init</Text>

      {step === "domain" && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text>Domain for tenant routes:</Text>
            <TextInput
              placeholder="lobster.local"
              onSubmit={handleDomainSubmit}
            />
          </Box>
        </Box>
      )}

      {step === "confirm" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>The following will be installed:</Text>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            {missingNames.map((name) => (
              <Text key={name}>- {name}</Text>
            ))}
          </Box>
          <Box marginTop={1} gap={1}>
            <Text>Proceed?</Text>
            <ConfirmInput onConfirm={handleConfirm} onCancel={handleCancel} />
          </Box>
        </Box>
      )}

      {step === "running" && (
        <Box marginTop={1}>
          <Spinner label="Initializing host..." />
        </Box>
      )}

      {step === "done" && error && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}

      {step === "done" && result && (
        <Box flexDirection="column" marginTop={1}>
          <StatusMessage variant="success">
            Host initialized successfully
          </StatusMessage>
          <Box flexDirection="column" marginLeft={2} marginTop={1}>
            <Text>
              KVM: <Text color="green">available</Text>
            </Text>
            {result.firecrackerInstalled && (
              <Text>
                Firecracker: <Text color="green">installed</Text>
              </Text>
            )}
            {result.kernelInstalled && (
              <Text>
                Kernel: <Text color="green">installed</Text>
              </Text>
            )}
            {result.rootfsInstalled && (
              <Text>
                Rootfs: <Text color="green">installed</Text>
              </Text>
            )}
            {result.caddyInstalled && (
              <Text>
                Caddy: <Text color="green">installed</Text>
              </Text>
            )}
            <Text>
              Directories: <Text color="green">created</Text>
            </Text>
            <Text>
              Origin certs:{" "}
              <Text color={result.certsInstalled ? "green" : "yellow"}>
                {result.certsInstalled
                  ? "installed"
                  : "not bundled (using ACME)"}
              </Text>
            </Text>
            <Text>
              IP forwarding: <Text color="green">enabled</Text>
            </Text>
            <Text>
              Caddy: <Text color="green">configured</Text>
            </Text>
            <Text>
              Watchdog:{" "}
              <Text color={result.servicesEnabled ? "green" : "yellow"}>
                {result.servicesEnabled ? "service enabled" : "not configured"}
              </Text>
            </Text>
          </Box>
          {pre.warnings.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="yellow">
                Security warnings:
              </Text>
              {pre.warnings.map((w) => (
                <Text key={w} color="yellow">
                  {" "}
                  {w}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
