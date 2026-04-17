/**
 * Footer — 3-row status region at the bottom of the screen.
 *
 * Row 1: dim separator line across full width
 * Row 2: column headers (left) + status/header text (right)
 * Row 3: prompt + input (handled by InputLine component, sibling)
 */

import { Box, Text } from "ink";
import { stripAnsi } from "../../core/packets";
import { useAppState } from "../hooks";

interface Props {
  width: number;
}

export function Footer({ width }: Props) {
  const { columnHeaders, headerLeft, headerRight, statusText } = useAppState();

  const rightParts: string[] = [];
  if (statusText) rightParts.push(statusText);
  if (headerLeft || headerRight) {
    const h = headerRight ? `${headerLeft}  ${headerRight}` : headerLeft;
    rightParts.push(h);
  }
  const right = rightParts.join("  ");

  let legend = "";
  if (columnHeaders && right) {
    const leftLen = stripAnsi(columnHeaders).length;
    const rightLen = stripAnsi(right).length;
    const usable = Math.max(leftLen + rightLen + 2, width - 1);
    const gap = Math.max(2, usable - leftLen - rightLen);
    legend = columnHeaders + " ".repeat(gap) + right;
  } else {
    legend = columnHeaders || right;
  }

  const sep = "─".repeat(Math.max(1, width - 1));

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text dimColor>{sep}</Text>
      <Text>{legend}</Text>
    </Box>
  );
}
