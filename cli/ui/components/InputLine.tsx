/**
 * InputLine — prompt + current buffer + block cursor.
 *
 * Renders the cursor as an inverted character at the insertion point,
 * matching the ink-text-input convention.
 */

import { Text } from "ink";
import { useAppState } from "../hooks";

export function InputLine() {
  const { prompt, inputText, inputCursor } = useAppState();
  const cursorAtEnd = inputCursor >= inputText.length;
  const before = inputText.slice(0, inputCursor);
  const at = cursorAtEnd ? " " : inputText[inputCursor];
  const after = cursorAtEnd ? "" : inputText.slice(inputCursor + 1);

  return (
    <Text>
      <Text dimColor>{prompt}</Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Text>
  );
}
