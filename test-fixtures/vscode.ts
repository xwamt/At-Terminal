export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export class TreeItem {
  label?: string;
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  command?: unknown;
  description?: string;
  tooltip?: string;

  constructor(label?: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = [];

  event = (listener: (value: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((entry) => entry !== listener);
      }
    };
  };

  fire(value: T): void {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  constructor(
    public readonly fsPath: string,
    public readonly scheme = 'file',
    public readonly path = fsPath,
    public readonly query = ''
  ) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...paths: string[]): Uri {
    return new Uri([base.fsPath, ...paths].join('/'));
  }

  static from(parts: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(parts.path, parts.scheme, parts.path, parts.query ?? '');
  }

  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

export const ThemeIcon = class {
  constructor(public readonly id: string) {}
};

export interface TextDocument {
  uri: Uri;
  fileName: string;
  languageId?: string;
  isDirty?: boolean;
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export class StatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  visible = false;

  show(): void {
    this.visible = true;
  }

  hide(): void {
    this.visible = false;
  }

  dispose(): void {
    this.visible = false;
  }
}

const didSaveTextDocument = new EventEmitter<TextDocument>();
const didCloseTextDocument = new EventEmitter<TextDocument>();

export const window = {
  showErrorMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  createTreeView: () => ({ dispose: () => undefined }),
  createWebviewPanel: () => ({ dispose: () => undefined }),
  showTextDocument: async (document: TextDocument) => document,
  createStatusBarItem: (_alignment?: StatusBarAlignment, _priority?: number) => new StatusBarItem()
};

export const languages = {
  setTextDocumentLanguage: async (document: TextDocument, languageId: string): Promise<TextDocument> => ({
    ...document,
    languageId
  })
};

export const commands = {
  registerCommand: () => ({ dispose: () => undefined }),
  executeCommand: async () => undefined
};

export const workspace = {
  registerTextDocumentContentProvider: () => ({ dispose: () => undefined }),
  openTextDocument: async (uri: Uri): Promise<TextDocument> => ({
    uri,
    fileName: uri.fsPath,
    isDirty: false
  }),
  onDidSaveTextDocument: didSaveTextDocument.event,
  onDidCloseTextDocument: didCloseTextDocument.event,
  __fireDidSaveTextDocument: (document: TextDocument) => didSaveTextDocument.fire(document),
  __fireDidCloseTextDocument: (document: TextDocument) => didCloseTextDocument.fire(document),
  getConfiguration: () => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  })
};

export const env = {
  clipboard: {
    writeText: async (_value: string) => undefined
  }
};

export enum ViewColumn {
  Active = -1,
  Beside = -2
}
