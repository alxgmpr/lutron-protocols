/**
 * Footer — 4-row status region at the bottom of the screen.
 *
 * Row 1: dim separator line across full width
 * Row 2: column header labels
 * Row 3: status text + packet counts / header
 * Row 4: prompt + input (handled by InputLine component, sibling)
 */

import { Box, Text } from "ink";
import { useAppState } from "../hooks";

interface Props {
  width: number;
}

export function Footer({ width }: Props) {
  const { columnHeaders, headerLeft, headerRight, statusText } = useAppState();

  const statusParts: string[] = [];
  if (statusText) statusParts.push(statusText);
  if (headerLeft || headerRight) {
    statusParts.push(
      headerRight ? `${headerLeft}  ${headerRight}` : headerLeft,
    );
  }
  const statusLine = statusParts.join("  ");

  const sep = "─".repeat(Math.max(1, width - 1));

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{sep}</Text>
      <Text wrap="truncate-end">{columnHeaders}</Text>
      <Text wrap="truncate-end">{statusLine}</Text>
    </Box>
  );
}
