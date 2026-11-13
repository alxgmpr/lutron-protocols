/**
 * Detail — packet inspector shown below the log while a row is selected:
 * field-coloured hex dump plus decoded fields, diffed against the same
 * device's previous packet (see core/detail.ts).
 */

import { Box, Text } from "ink";
import { memo, useMemo } from "react";
import { previousFromDevice, renderDetail } from "../../core/detail";
import { DIM, type PacketRow, RESET } from "../../core/packets";
import { store } from "../store";

interface Props {
  row: PacketRow;
  height: number;
  width: number;
}

const HINT = `${DIM}↑↓/jk move · PgUp/PgDn page · Esc close${RESET}`;

export const Detail = memo(function Detail({ row, height, width }: Props) {
  // The previous packet only depends on what came before `row`, which can't
  // change, so look it up once per selection rather than on every append.
  const prev = useMemo(
    () => previousFromDevice(store.getState().entries, row),
    [row],
  );
  const body = renderDetail(row, width - 1, prev).slice(
    0,
    Math.max(0, height - 1),
  );
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
