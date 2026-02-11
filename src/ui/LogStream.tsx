import { Box, Text } from "ink";

interface Props {
  title: string;
  lines: string[];
  maxLines?: number;
}

export function LogStream({ title, lines, maxLines = 30 }: Props) {
  const visible = lines.slice(-maxLines);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold inverse>
          {" "}
          {title}{" "}
        </Text>
        <Text dimColor>
          {" "}
          ({lines.length} lines, showing last {maxLines}){" "}
        </Text>
      </Box>
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press q to quit</Text>
      </Box>
    </Box>
  );
}
