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

type GoBridge = {
  main: {
    App: {
      SelectFile(): Promise<FileInfo | null>;
      SelectOutputDir(): Promise<string>;
      Compress(req: ProcessRequest): Promise<ProcessResult>;
      Convert(req: ProcessRequest): Promise<ProcessResult>;
      CheckFFmpeg(): Promise<boolean>;
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
