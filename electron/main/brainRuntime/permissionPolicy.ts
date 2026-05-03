import type { BrainToolDefinition } from './types';

export function canExecuteWithoutConfirmation(tool: BrainToolDefinition): boolean {
  return !tool.requiresConfirmation && (
    tool.permissionLevel === 'read' ||
    tool.permissionLevel === 'view' ||
    tool.permissionLevel === 'brain_write'
  );
}
