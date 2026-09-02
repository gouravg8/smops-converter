export type FileInfo = {
  path: string;
  name: string;
  extension: string;
  kind: 'image' | 'video' | 'unknown';
  sizeBytes: number;
  sizeLabel: string;
};

export type ProcessRequest = {
  inputPath: string;
  outputDir: string;
  outputName: string;
  format: string;
  maxSizeMB: number;
  mode: 'compress' | 'convert';
};

export type ProcessResult = {
  outputPath: string;
  outputName: string;
  sizeBytes: number;
  sizeLabel: string;
  message: string;
};

export type UpdateInfo = {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  url: string;
  notes: string;
  mandatory: boolean;
  publishedAt: string;
};

type GoBridge = {
  main: {
    App: {
      SelectFile(): Promise<FileInfo | null>;
      SelectOutputDir(): Promise<string>;
      OpenInFolder(path: string): Promise<void>;
      InstallFFmpeg(): Promise<void>;
      Compress(req: ProcessRequest): Promise<ProcessResult>;
      Convert(req: ProcessRequest): Promise<ProcessResult>;
      CheckFFmpeg(): Promise<boolean>;
      GetAppVersion(): Promise<string>;
      CheckForUpdate(): Promise<UpdateInfo>;
      DownloadAndInstallUpdate(url: string): Promise<void>;
      Cancel(): Promise<void>;
      GetFileInfo(path: string): Promise<FileInfo>;
    };
  };
};

const bridge = () => (window as unknown as { go?: GoBridge }).go?.main.App;

export function appApi() {
  const api = bridge();
  if (!api) {
    throw new Error('Wails bridge is not ready. Run this app with Wails.');
  }
  return api;
}
