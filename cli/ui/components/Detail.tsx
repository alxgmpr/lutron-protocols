/**
 * Detail — packet inspector shown below the log while a row is selected:
 * field-coloured hex dump plus decoded fields (see core/detail.ts).
 */

import { Box, Text } from "ink";
import { memo } from "react";
import { renderDetail } from "../../core/detail";
import { DIM, type PacketRow, RESET } from "../../core/packets";

interface Props {
  row: PacketRow;
  height: number;
  width: number;
}

const HINT = `${DIM}↑↓/jk move · PgUp/PgDn page · Esc close${RESET}`;

export const Detail = memo(function Detail({ row, height, width }: Props) {
  const body = renderDetail(row, width - 1).slice(0, Math.max(0, height - 1));
  const sep = "─".repeat(Math.max(1, width - 1));
  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      <Text wrap="truncate-end">
        {`${DIM}${sep.slice(0, Math.max(0, width - 44))}${RESET} ${HINT}`}
      </Text>
      {body.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-layout pane
        <Text key={i} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  );
});
