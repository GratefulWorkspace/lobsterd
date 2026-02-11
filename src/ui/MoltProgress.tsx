import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import type {
  MoltProgress as MoltProgressData,
  MoltTenantResult,
} from "../commands/molt.js";

interface ActiveProps {
  progress: MoltProgressData[];
}

export function MoltProgressView({ progress }: ActiveProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>🦞 Molting...</Text>
      <Box flexDirection="column" marginTop={1}>
        {progress.map((p, i) => (
          <Box key={i} gap={1}>
            <Box width={20}>
              <Text bold>{p.tenant}</Text>
            </Box>
            <Box>
              {p.phase === "done" ? (
                <Text color={p.detail?.includes("Healthy") ? "green" : "red"}>
                  {p.detail?.includes("Healthy") ? "●" : "✗"} {p.detail}
                </Text>
              ) : (
                <Box gap={1}>
                  <Spinner
                    label={`${p.phase}${p.detail ? `: ${p.detail}` : ""}`}
                  />
                </Box>
              )}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

interface ResultsProps {
  results: MoltTenantResult[];
}

export function MoltResults({ results }: ResultsProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>🦞 Molt Results</Text>
      <Box flexDirection="column" marginTop={1}>
        {results.map((r) => (
          <Box key={r.tenant} flexDirection="column" marginBottom={1}>
            <Text bold color={r.healthy ? "green" : "red"}>
              {r.healthy ? "●" : "✗"} {r.tenant}
            </Text>
            {r.repairs.length > 0 && (
              <Box flexDirection="column" marginLeft={2}>
                {r.repairs.map((rep, i) => (
                  <Box key={i} flexDirection="column">
                    <Text dimColor>
                      {rep.fixed ? "↳ fixed" : "↳ failed"}: {rep.repair}
                    </Text>
                    {rep.actions.map((a, j) => (
                      <Text key={j} dimColor>
                        {" "}
                        {a}
                      </Text>
                    ))}
                  </Box>
                ))}
              </Box>
            )}
            {r.repairs.length === 0 && r.healthy && (
              <Box marginLeft={2}>
                <Text dimColor>Already healthy — no repairs needed</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
