import React from 'react';
import { Box, Text } from 'ink';
import type { TenantWatchState, HealthCheckResult } from '../types/index.js';
import { WATCH_STATE_COLORS, WATCH_STATE_SYMBOLS, STATUS_SYMBOLS, STATUS_COLORS } from './theme.js';

interface Props {
  name: string;
  port: number;
  watchState: TenantWatchState;
}

function CheckBadge({ label, results }: { label: string; results: HealthCheckResult[] }) {
  const worst = results.reduce<'ok' | 'degraded' | 'failed'>((acc, r) => {
    if (r.status === 'failed') return 'failed';
    if (r.status === 'degraded' && acc !== 'failed') return 'degraded';
    return acc;
  }, 'ok');

  return (
    <Text color={STATUS_COLORS[worst]}>
      {STATUS_SYMBOLS[worst]} {label}
    </Text>
  );
}

export function TenantRow({ name, port, watchState }: Props) {
  const stateColor = WATCH_STATE_COLORS[watchState.state];
  const stateSymbol = WATCH_STATE_SYMBOLS[watchState.state];

  const vmResults = watchState.lastResults.filter((r) => r.check.startsWith('vm.'));
  const netResults = watchState.lastResults.filter((r) => r.check.startsWith('net.'));

  return (
    <Box gap={2}>
      <Box width={20}>
        <Text color={stateColor} bold>
          {stateSymbol} {name}
        </Text>
      </Box>
      <Box width={8}>
        <Text dimColor>:{port}</Text>
      </Box>
      <Box width={12}>
        <Text color={stateColor}>{watchState.state}</Text>
      </Box>
      <Box gap={1}>
        {vmResults.length > 0 && <CheckBadge label="VM" results={vmResults} />}
        {netResults.length > 0 && <CheckBadge label="Net" results={netResults} />}
      </Box>
    </Box>
  );
}
