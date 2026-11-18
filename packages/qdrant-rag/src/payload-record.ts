import type { RagMetadata } from '@mcp-abap-adt/llm-agent';

/**
 * The single payload → record mapping: `upsert` stores `{ text, ...metadata }`
 * flat, so the text is lifted out and everything else is the metadata.
 */
export function splitPayload(payload: Record<string, unknown>): {
  text: string;
  metadata: RagMetadata;
} {
  const {
    text,
    [recordPointIdKey]: _recordPointId,
    [fragmentIndexKey]: _fragmentIndex,
    ...rest
  } = payload;
  return {
    text: isFragmentedText(text) ? text.value : String(text ?? ''),
    metadata: rest as RagMetadata,
  };
}

interface FragmentedText {
  value: string;
  fragmentVectors: number[][];
}

export const recordPointIdKey = '_ragRecordPointId';
export const fragmentIndexKey = '_ragFragmentIndex';

function isFragmentedText(value: RagMetadata[string]): value is FragmentedText {
  return (
    value !== null &&
    typeof value === 'object' &&
    'value' in value &&
    typeof value.value === 'string' &&
    'fragmentVectors' in value &&
    Array.isArray(value.fragmentVectors)
  );
}
