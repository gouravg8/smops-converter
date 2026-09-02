import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Archive,
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileVideo,
  FolderOpen,
  Loader2,
  Repeat2,
  Trash2,
  Upload,
  X
} from 'lucide-react';
import './index.css';
import { appApi, FileInfo, ProcessResult, UpdateInfo } from './wails';
import { EventsOff, EventsOn } from '../wailsjs/runtime/runtime';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const imageFormats = ['jpg', 'jpeg', 'png', 'webp'];
const videoFormats = ['mp4', 'webm', 'mkv', 'avi', 'm4v'];

function pickDefaultFormat(info: FileInfo): string {
  const ext = info.extension.toLowerCase();
  const normalized = ext === 'jpeg' ? 'jpg' : ext;
  if (info.kind === 'video') {
    if ((videoFormats as string[]).includes(normalized)) return normalized;
    if ((videoFormats as string[]).includes(ext)) return ext;
    return 'mp4';
  }
  if (info.kind === 'image') {
    if ((imageFormats as string[]).includes(normalized)) return normalized;
    if ((imageFormats as string[]).includes(ext)) return ext;
    return 'jpg';
  }
  // unknown kind — try either list
  if ((imageFormats as string[]).includes(normalized) || (videoFormats as string[]).includes(normalized)) return normalized;
  return normalized || 'jpg';
}

function App() {
  const [tab, setTab] = useState<'compress' | 'convert'>('compress');
  const [file, setFile] = useState<FileInfo | null>(null);
  const [outputDir, setOutputDir] = useState('');
  const [outputName, setOutputName] = useState('');
  const [format, setFormat] = useState('jpg');
  const [maxSizeMB, setMaxSizeMB] = useState(5);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressStage, setProgressStage] = useState('Ready');
  const [ffmpegReady, setFfmpegReady] = useState(true);
  const [installingFFmpeg, setInstallingFFmpeg] = useState(false);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [error, setError] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [appVersion, setAppVersion] = useState('0.0.1');

  const formats = useMemo(() => {
    if (file?.kind === 'video') return videoFormats;
    return imageFormats;
  }, [file]);

  useEffect(() => {
    appApi().CheckFFmpeg().then(setFfmpegReady).catch(() => setFfmpegReady(false));
  }, []);

  // Auto-update check: fetch version.json on launch + every 6h, plus push via Go event
  useEffect(() => {
    appApi().GetAppVersion().then(setAppVersion).catch(() => {});
    const check = () => {
      setCheckingUpdate(true);
      (appApi().CheckForUpdate() as Promise<UpdateInfo>).then((info) => {
        if (info?.available) setUpdateInfo(info);
      }).catch(() => {}).finally(() => setCheckingUpdate(false));
    };
    check();
    const onUpdate = (info: UpdateInfo) => setUpdateInfo(info);
    EventsOn('update-available', onUpdate);
    const id = window.setInterval(check, 6 * 60 * 60 * 1000);
    return () => { EventsOff('update-available'); window.clearInterval(id); };
  }, []);

  useEffect(() => {
    EventsOn('job-progress', (event: { percent: number; stage: string }) => {
      setProgress(event.percent);
      setProgressStage(event.stage);
    });
    return () => EventsOff('job-progress');
  }, []);

  // Wails drag & drop via Go: file-dropped + error — blocked when busy
  useEffect(() => {
    const onDropped = (info: FileInfo) => {
      if (busy) {
        setError('A process is running — cancel it first to drop a new file');
        setIsDragOver(false);
        return;
      }
      setError('');
      setResult(null);
      setFile(info);
      setOutputName(suggestOutputName(info.name, tab));
      setFormat(pickDefaultFormat(info));
      setProgress(0);
      setProgressStage('Ready');
      setIsDragOver(false);
    };
    const onError = (msg: string) => {
      setError(msg);
      setIsDragOver(false);
    };
    EventsOn('file-dropped', onDropped);
    EventsOn('file-dropped-error', onError);
    // also listen to raw wails:file-drop for safety (x,y,paths)
    EventsOn('wails:file-drop', (_x: number, _y: number, paths: string[]) => {
      if (busy) {
        setError('A process is running — cancel it first to drop a new file');
        setIsDragOver(false);
        return;
      }
      if (paths && paths.length > 0) {
        appApi
          .GetFileInfo(paths[0])
          .then(onDropped)
          .catch((e: any) => onError(e instanceof Error ? e.message : String(e)));
      }
    });
    return () => {
      EventsOff('file-dropped');
      EventsOff('file-dropped-error');
      EventsOff('wails:file-drop');
    };
  }, [tab, busy]);

  // Prevent browser default drag handling that causes ghost glitch
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    if (!formats.includes(format)) {
      setFormat(formats[0]);
    }
  }, [formats, format]);

  useEffect(() => {
    if (file) {
      setOutputName(suggestOutputName(file.name, tab));
    }
  }, [tab]);

  function handleDragOver(e: React.DragEvent) {
    if (busy) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    // only leave if leaving dropzone itself
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (busy) {
      setError('A process is running — cancel it first to drop a new file');
      return;
    }
    // Try HTML5 files first (for browser dev)
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const f = files[0] as any;
      // In Wails, dropped file path is available via file.path (webkit) or via wails event
      const droppedPath = f.path as string | undefined;
      if (droppedPath) {
        try {
          const info = await appApi.GetFileInfo(droppedPath);
          setError('');
          setResult(null);
          setFile(info);
          setOutputName(suggestOutputName(info.name, tab));
          setFormat(pickDefaultFormat(info));
          setProgress(0);
          setProgressStage('Ready');
          return;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }
      // Fallback: wails will already emit file-dropped, just wait
      return;
    }
  }

  async function selectFile() {
    if (busy) {
      setError('A process is running — cancel it first to select a new file');
      return;
    }
    setError('');
    setResult(null);
    const selected = await appApi().SelectFile();
    if (selected) {
      setFile(selected);
      setOutputName(suggestOutputName(selected.name, tab));
      setFormat(pickDefaultFormat(selected));
      setProgress(0);
      setProgressStage('Ready');
    }
  }

  async function selectOutputDir() {
    setError('');
    const selected = await appApi().SelectOutputDir();
    if (selected) setOutputDir(selected);
  }

  function removeCurrentFile() {
    setFile(null);
    setResult(null);
    setError('');
    setOutputName('');
    setProgress(0);
    setProgressStage('Ready');
    setFormat('jpg');
  }

  async function runJob() {
    if (!file) {
      setError('Choose an image or video first.');
      return;
    }
    setBusy(true);
    setError('');
    setResult(null);
    setProgress(0);
    setProgressStage('Starting');
    try {
      const payload = {
        inputPath: file.path,
        outputDir,
        outputName,
        format,
        maxSizeMB,
        mode: tab
      };
      const nextResult = tab === 'compress' ? await appApi().Compress(payload) : await appApi().Convert(payload);
      setResult(nextResult);
      setProgress(100);
      setProgressStage('Complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('cancel')) {
        setError('');
        setProgress(0);
        setProgressStage('Cancelled');
      } else {
        setError(msg);
        setProgress(0);
        setProgressStage('Ready');
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    try {
      await appApi().Cancel();
    } catch {}
    setProgressStage('Cancelling...');
  }

  async function installFFmpeg() {
    setInstallingFFmpeg(true);
    setError('');
    setProgress(0);
    setProgressStage('Installing FFmpeg');
    try {
      await appApi().InstallFFmpeg();
      const ready = await appApi().CheckFFmpeg();
      setFfmpegReady(ready);
      setProgress(ready ? 100 : 0);
      setProgressStage(ready ? 'FFmpeg ready' : 'Install instructions opened');
    } catch (err) {
      const ready = await appApi().CheckFFmpeg();
      setFfmpegReady(ready);
      setError(err instanceof Error ? err.message : String(err));
      setProgress(ready ? 100 : 0);
      setProgressStage(ready ? 'FFmpeg ready' : 'Ready');
    } finally {
      setInstallingFFmpeg(false);
    }
  }

  async function handleUpdate() {
    if (!updateInfo?.url) return;
    setDownloadingUpdate(true);
    setError('');
    setProgress(0);
    setProgressStage('Downloading update');
    try {
      await appApi().DownloadAndInstallUpdate(updateInfo.url);
      // installer launched — will quit shortly via Go
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress(0);
      setProgressStage('Ready');
      setDownloadingUpdate(false);
    }
  }

  async function openResultFolder() {
    if (!result) return;
    setError('');
    try {
      await appApi().OpenInFolder(result.outputPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const selectedIcon = file?.kind === 'video' ? <FileVideo className="h-7 w-7" /> : <FileImage className="h-7 w-7" />;
  const actionLabel = tab === 'compress' ? 'Compress file' : 'Convert format';

  return (
    <div
      className="min-h-screen w-screen bg-[#080808] text-foreground flex flex-col overflow-hidden selection:bg-white selection:text-black"
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Top nav - premium black, no blue bg */}
      <header className="h-[56px] flex items-center justify-between border-b border-white/[0.06] bg-[#0a0a0a] px-6 shrink-0">
        <div className="flex items-center gap-3">
          <img src="/so-logo.png" alt="SmoothOps" className="h-6 w-auto object-contain opacity-90" onError={(e) => ((e.currentTarget.style.display = 'none'))} />
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-[700] tracking-[0.14em] text-zinc-100">SMOOTHOPS</span>
            <span className="text-[15px] font-[300] tracking-wide text-zinc-400">Converter</span>
          </div>
          <span className="hidden md:inline-flex ml-4 text-[11px] font-medium tracking-widest text-zinc-500 border-l border-white/10 pl-4">v{appVersion}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${ffmpegReady ? 'bg-zinc-900 border-white/10 text-zinc-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ffmpegReady ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
            {ffmpegReady ? 'FFmpeg ready' : 'FFmpeg missing'}
          </div>
          {!ffmpegReady && (
            <Button
              size="sm"
              onClick={installFFmpeg}
              disabled={installingFFmpeg}
              className="h-7 border border-primary/30 bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-bold cursor-pointer shadow-[0_0_12px_rgba(45,212,191,0.25)] animate-pulse hover:animate-none"
            >
              {installingFFmpeg ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {installingFFmpeg ? 'Installing...' : 'Install FFmpeg'}
            </Button>
          )}
        </div>
      </header>

      {/* Update banner — shown when newer version is on server; replaces old build on “Update now” */}
      {updateInfo?.available && (
        <div className="mx-4 md:mx-6 mt-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 shrink-0">
          <div className="flex items-center gap-2 text-amber-200 text-sm font-medium flex-1 min-w-0">
            <Download className="h-4 w-4 shrink-0" />
            <span className="truncate">Update available: v{updateInfo.latestVersion} (you have v{updateInfo.currentVersion}){updateInfo.notes ? ` — ${updateInfo.notes}` : ''}</span>
            {checkingUpdate && <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" onClick={handleUpdate} disabled={downloadingUpdate} className="h-8 bg-amber-500 text-black hover:bg-amber-400 font-semibold cursor-pointer">
              {downloadingUpdate ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {downloadingUpdate ? 'Downloading…' : 'Update now'}
            </Button>
            {!updateInfo.mandatory && (
              <Button size="sm" variant="ghost" onClick={() => setUpdateInfo(null)} className="h-8 text-amber-200/70 hover:text-amber-100 hover:bg-amber-500/10 cursor-pointer"><X className="h-3.5 w-3.5" /> Dismiss</Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => { setCheckingUpdate(true); (appApi().CheckForUpdate() as Promise<UpdateInfo>).then(i=>{ if(i?.available) setUpdateInfo(i)}).finally(()=>setCheckingUpdate(false)); }} className="h-8 text-zinc-400 hover:text-zinc-100 cursor-pointer">Check again</Button>
          </div>
        </div>
      )}

      {isDragOver && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] grid place-items-center pointer-events-none">
          <div className="rounded-xl border border-primary/20 bg-[#111111] px-8 py-6 text-center shadow-2xl">
            <div className="mx-auto h-12 w-12 grid place-items-center rounded-full bg-primary text-primary-foreground mb-3">
              <Upload className="h-6 w-6" />
            </div>
            <div className="text-sm font-medium text-white">Drop file here</div>
            <div className="text-xs text-zinc-500 mt-1">JPG, PNG, WEBP, MP4, MOV, MKV...</div>
          </div>
        </div>
      )}

      {/* Workspace - full dims, shades of black */}
      <main className="flex-1 w-full px-4 md:px-6 py-6 overflow-auto bg-[#080808]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
          <TabsList className="bg-[#141414] border border-white/[0.06] p-1 h-9 mb-6 w-full sm:w-auto inline-flex rounded-lg">
            <TabsTrigger value="compress" disabled={busy} className="gap-2 rounded-md text-zinc-400 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm font-medium cursor-pointer disabled:opacity-40">
              <Archive className="h-3.5 w-3.5" /> Compress
            </TabsTrigger>
            <TabsTrigger value="convert" disabled={busy} className="gap-2 rounded-md text-zinc-400 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm font-medium cursor-pointer disabled:opacity-40">
              <Repeat2 className="h-3.5 w-3.5" /> Convert
            </TabsTrigger>
          </TabsList>

          <div className="grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] xl:grid-cols-[1.1fr_0.9fr] gap-6 items-start max-w-[1600px] mx-auto w-full">
            {/* Left: Tool panel - premium black card */}
            <Card className="border-white/[0.06] bg-[#111111] overflow-hidden shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_1px_20px_rgba(0,0,0,0.4)]">
              <CardContent className="p-5 md:p-6 space-y-5">
                <button
                  onClick={selectFile}
                  disabled={busy}
                  onDragOver={handleDragOver}
                  onDragEnter={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  className={`w-full flex items-center gap-4 rounded-xl border p-5 text-left transition-all ${busy ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'} ${isDragOver ? 'border-white bg-white/[0.08] border-solid' : file ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06]' : 'border-dashed border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'}`}
                >
                  <div className={`h-12 w-12 shrink-0 grid place-items-center rounded-full border transition-colors ${isDragOver ? 'bg-primary text-primary-foreground border-primary' : file ? 'bg-primary text-primary-foreground border-primary' : 'bg-primary/15 text-primary border-primary/20'}`}>{isDragOver ? <Download className="h-5 w-5 animate-bounce" /> : file ? selectedIcon : <Upload className="h-5 w-5" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-zinc-100">{isDragOver ? 'Drop file here' : file ? file.name : 'Select image or video'}</div>
                    <div className={`truncate text-xs mt-1 font-normal ${isDragOver ? 'text-zinc-300' : 'text-zinc-500'}`}>{isDragOver ? 'Release to load image or video' : file ? `${file.kind.toUpperCase()} • ${file.extension.toUpperCase()} • ${file.sizeLabel}` : 'JPG, PNG, WEBP, MP4, MOV, MKV, AVI, WEBM • or drag & drop'}</div>
                  </div>
                </button>

                {file && (
                  <Button variant="ghost" size="sm" onClick={removeCurrentFile} disabled={busy} className="h-7 text-zinc-500 hover:text-zinc-200 hover:bg-white/5 -mt-2 text-xs cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed">
                    <Trash2 className="h-3.5 w-3.5" /> Remove file
                  </Button>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tab === 'compress' && (
                    <div className="space-y-2">
                      <Label htmlFor="max-size" className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Max output size</Label>
                      <div className="relative flex items-center rounded-md border border-white/10 bg-[#0a0a0a] focus-within:border-white/20 focus-within:ring-1 focus-within:ring-white/10">
                        <Input
                          id="max-size"
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={maxSizeMB}
                          onChange={(e) => setMaxSizeMB(Number(e.target.value))}
                          disabled={busy}
                          className="border-0 bg-transparent pr-14 focus-visible:ring-0 focus-visible:border-0 shadow-none disabled:opacity-40"
                        />
                        <span className="absolute right-1 inline-flex h-7 items-center rounded-md bg-zinc-900 border border-white/10 px-2.5 text-xs font-semibold text-zinc-400 pointer-events-none">MB</span>
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output format</Label>
                    <Select value={format} onValueChange={setFormat} disabled={busy}>
                      <SelectTrigger className="bg-[#0a0a0a] border-white/10 disabled:opacity-40"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-[#141414] border-white/10">
                        {formats.map((item) => (
                          <SelectItem key={item} value={item}>{item.toUpperCase()}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output name</Label>
                    <Input value={outputName} onChange={(e) => setOutputName(e.target.value)} placeholder="Leave blank to auto-name" disabled={busy} className="bg-[#0a0a0a] border-white/10 focus-visible:border-white/20 placeholder:text-zinc-600 disabled:opacity-40" />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output folder</Label>
                    <div className="flex gap-2">
                      <Input value={outputDir || 'Same as source file'} readOnly disabled={busy} className="bg-[#0a0a0a] border-white/10 text-zinc-500 disabled:opacity-40" />
                      <Button type="button" onClick={selectOutputDir} disabled={busy} size="icon" className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 border border-primary cursor-pointer disabled:opacity-40">
                        <FolderOpen className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-3 border-t border-white/[0.06]">
                  <div className="flex justify-between text-[11px] font-medium tracking-wide">
                    <span className="text-zinc-500 uppercase">{progressStage}</span>
                    <span className="text-zinc-200 tabular-nums">{progress}%</span>
                  </div>
                  <Progress value={progress} className="h-1.5 bg-zinc-900 [&>div]:bg-primary" />
                </div>

                {busy ? (
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <Button disabled className="h-[44px] text-[13px] font-semibold bg-primary/80 text-primary-foreground cursor-not-allowed">
                      <Loader2 className="h-4 w-4 animate-spin" /> Working...
                    </Button>
                    <Button onClick={cancelJob} variant="outline" className="h-[44px] px-6 border-white/15 bg-transparent hover:bg-white/10 text-zinc-200 cursor-pointer">
                      <X className="h-4 w-4" /> Cancel
                    </Button>
                  </div>
                ) : (
                  <Button onClick={runJob} disabled={!ffmpegReady} className="w-full h-[44px] text-[13px] font-semibold bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_1px_0_rgba(255,255,255,0.1)_inset] disabled:opacity-40 cursor-pointer">
                    {tab === 'compress' ? <Archive className="h-4 w-4" /> : <Download className="h-4 w-4" />}
                    {actionLabel}
                  </Button>
                )}

                {error && <div className="rounded-lg bg-red-500/[0.06] border border-red-500/20 p-3 text-sm font-medium text-red-400">{error}</div>}
              </CardContent>
            </Card>

            {/* Right: Output */}
            <Card className="border-white/[0.06] bg-[#111111] sticky top-6 shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset]">
              <CardHeader className="pb-3 border-b border-white/[0.06]">
                <CardTitle className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">{tab === 'compress' ? 'Compression output' : 'Conversion output'}</CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                {result ? (
                  <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="h-8 w-8 grid place-items-center rounded-full bg-primary text-primary-foreground shrink-0">
                        <CheckCircle2 className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm text-zinc-100 truncate">{result.outputName}</div>
                        <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1.5">{result.sizeLabel} <span className="h-1 w-1 rounded-full bg-white/20" /> <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-zinc-800 border border-white/10 text-zinc-300 text-[11px] font-medium">Completed</span></div>
                      </div>
                    </div>
                    <code className="block rounded-lg bg-[#141414] p-3 text-xs break-all text-zinc-400 border border-white/10 font-mono">{result.outputPath}</code>
                    <Button onClick={openResultFolder} className="w-full bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer">
                      <ExternalLink className="h-4 w-4" /> Show in folder
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-6 text-center space-y-3">
                    <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output file</div>
                    {file ? (
                      <>
                        <div className="text-sm font-medium text-zinc-100 break-all">{(outputName ? outputName.replace(/\.[^/.]+$/, '') : file.name.replace(/\.[^/.]+$/, '').replace(/-compressed$|-converted$/, '') + (tab === 'compress' ? '-compressed' : '-converted')) + '.' + format}</div>
                        <div className="text-xs text-zinc-500">Format: {format.toUpperCase()} • Folder: <span className="text-zinc-400">{outputDir || 'Same as source'}</span></div>
                        <div className="text-xs text-zinc-600">Will be created after you run {tab === 'compress' ? 'compression' : 'conversion'}</div>
                      </>
                    ) : (
                      <>
                        <div className="text-sm font-medium text-zinc-400">No output yet</div>
                        <div className="text-xs text-zinc-600">Select a file and run {tab === 'compress' ? 'compress' : 'convert'} to generate output file here</div>
                      </>
                    )}
                  </div>
                )}
                <div className="mt-4 flex items-center gap-2 text-xs text-zinc-600 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-500" />
                  {file ? `${formats.length} formats available` : 'Ready • Drop a file to start'}
                </div>
              </CardContent>
            </Card>
          </div>
        </Tabs>
      </main>

      <footer className="h-9 flex items-center justify-center px-6 border-t border-white/[0.06] bg-[#050505] text-[11px] tracking-wide text-zinc-600 shrink-0">
        <span className="font-medium">SmoothOps © {new Date().getFullYear()} • NEXPRO AI LLP • All Rights Reserved.</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

function suggestOutputName(fileName: string, mode: 'compress' | 'convert') {
  const dotIndex = fileName.lastIndexOf('.');
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-${mode === 'compress' ? 'compressed' : 'converted'}`;
}
