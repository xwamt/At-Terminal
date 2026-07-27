export const COMMAND_PREVIEW_MAX_LINES = 20;
export const COMMAND_PREVIEW_MAX_CHARS = 800;

export function truncateCommandPreview(
  command: string,
  maxLines = COMMAND_PREVIEW_MAX_LINES,
  maxChars = COMMAND_PREVIEW_MAX_CHARS
): string {
  const totalChars = command.length;
  const totalLines = command.length === 0 ? 0 : command.split('\n').length;
  let preview = command;
  const lines = command.split('\n');
  if (lines.length > maxLines) {
    preview = lines.slice(0, maxLines).join('\n');
  }
  if (preview.length > maxChars) {
    preview = preview.slice(0, maxChars);
  }
  if (preview !== command) {
    return `${preview}\n… (truncated, ${totalChars} chars, ${totalLines} lines)`;
  }
  return command;
}

export function formatRemoteCommandConfirmMessage(options: {
  serverLabel: string;
  host: string;
  command: string;
  destructive: boolean;
}): string {
  const preview = truncateCommandPreview(options.command);
  const warning = options.destructive ? '\n\nWarning: this command appears destructive.' : '';
  return `Run remote command on ${options.serverLabel} (${options.host})?\n\n${preview}${warning}`;
}
