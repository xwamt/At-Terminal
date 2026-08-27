/**
 * Narrow confirmation-banner heuristic. It does not authorize execution.
 */
export function looksDestructive(command: string): boolean {
  return /\b(rm\s+-[^\n]*r|mkfs|shutdown|reboot|poweroff|dd\s+if=)/i.test(command);
}
