import type { BrainToolResult } from './types';

export function toolResultContent(result: BrainToolResult): string {
  if (result.isError) {
    return [
      '<tool_use_error>',
      `tool=${result.toolName}`,
      result.content,
      '</tool_use_error>'
    ].join('\n');
  }

  return [
    '<tool_result>',
    `tool=${result.toolName}`,
    result.content,
    '</tool_result>'
  ].join('\n');
}
