export interface ModelInfoRow {
  id: number;
  name: string;
}

export interface ModelInfoOutput {
  _comment: string;
  _extracted: string;
  _version: string;
  models: ModelInfoRow[];
  duplicateNames: Array<{ name: string; ids: number[] }>;
}

export function parseModelInfo(input: string): ModelInfoRow[] {
  const models: ModelInfoRow[] = [];
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("-") || line.startsWith("MODEL")) continue;

    const pipeIdx = line.indexOf("|");
    if (pipeIdx < 0) continue;

    const idStr = line.slice(0, pipeIdx).trim();
    const name = line.slice(pipeIdx + 1).trim();
    const id = Number.parseInt(idStr, 10);

    if (!Number.isNaN(id) && name) {
      models.push({ id, name });
    }
  }

  return models;
}

export function buildModelInfoOutput(
  models: ModelInfoRow[],
  options?: { extractedAt?: string; version?: string },
): ModelInfoOutput {
  const byName = new Map<string, number[]>();
  for (const model of models) {
    const ids = byName.get(model.name) ?? [];
    ids.push(model.id);
    byName.set(model.name, ids);
  }

  return {
    _comment: "SQLMODELINFO model table extract. Prefixes: RR/HQ/HR/PJ only.",
    _extracted: options?.extractedAt ?? new Date().toISOString(),
    _version: options?.version ?? "26.0.1.100",
    models: [...models].sort((a, b) => a.name.localeCompare(b.name)),
    duplicateNames: [...byName.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([name, ids]) => ({ name, ids: [...ids].sort((a, b) => a - b) })),
  };
}
