import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  CheckCircle2,
  Download,
  ExternalLink,
  FileImage,
  FileVideo,
  FolderOpen,
  Gauge,
  Heart,
  Loader2,
  PackagePlus,
  Repeat2,
  Trash2,
  Upload
} from 'lucide-react';
import './index.css';
import { appApi, FileInfo, ProcessResult } from './wails';
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

  const formats = useMemo(() => {
    if (file?.kind === 'video') return videoFormats;
    return imageFormats;
  }, [file]);

  useEffect(() => {
    appApi().CheckFFmpeg().then(setFfmpegReady).catch(() => setFfmpegReady(false));
  }, []);

  useEffect(() => {
    EventsOn('job-progress', (event: { percent: number; stage: string }) => {
      setProgress(event.percent);
      setProgressStage(event.stage);
    });
    return () => EventsOff('job-progress');
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

  async function selectFile() {
    setError('');
    setResult(null);
    const selected = await appApi().SelectFile();
    if (selected) {
      setFile(selected);
      setOutputName(suggestOutputName(selected.name, tab));
      setFormat(selected.kind === 'video' ? 'mp4' : 'jpg');
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
      setError(err instanceof Error ? err.message : String(err));
      setProgress(0);
      setProgressStage('Ready');
    } finally {
      setBusy(false);
    }
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
    <div className="min-h-screen w-screen bg-[#080808] text-foreground flex flex-col overflow-hidden selection:bg-white selection:text-black">
      {/* Top nav - premium black, no blue bg */}
      <header className="h-[56px] flex items-center justify-between border-b border-white/[0.06] bg-[#0a0a0a] px-6 shrink-0">
        <div className="flex items-center gap-3">
          <img src="/so-logo.png" alt="SmoothOps" className="h-6 w-auto object-contain opacity-90" onError={(e) => ((e.currentTarget.style.display = 'none'))} />
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-[700] tracking-[0.14em] text-zinc-100">SMOOTHOPS</span>
            <span className="text-[15px] font-[300] tracking-wide text-zinc-400">Converter</span>
          </div>
          <span className="hidden md:inline-flex ml-4 text-[11px] font-medium tracking-widest text-zinc-500 border-l border-white/10 pl-4">v2.1</span>
        </div>
        <div className="flex items-center gap-2">
          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${ffmpegReady ? 'bg-zinc-900 border-white/10 text-zinc-300' : 'bg-red-500/10 border-red-500/20 text-red-400'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${ffmpegReady ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
            {ffmpegReady ? 'FFmpeg ready' : 'FFmpeg missing'}
          </div>
          {!ffmpegReady && (
            <Button size="sm" variant="outline" onClick={installFFmpeg} disabled={installingFFmpeg} className="h-7 border-white/10 bg-white text-black hover:bg-zinc-200 text-xs font-semibold">
              {installingFFmpeg ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackagePlus className="h-3.5 w-3.5" />}
              {installingFFmpeg ? 'Installing...' : 'Install FFmpeg'}
            </Button>
          )}
        </div>
      </header>

      {/* Workspace - full dims, shades of black */}
      <main className="flex-1 w-full px-4 md:px-6 py-6 overflow-auto bg-[#080808]">
        <Tabs value={tab} onValueChange={(v) => setTab(v as any)} className="w-full">
          <TabsList className="bg-[#141414] border border-white/[0.06] p-1 h-9 mb-6 w-full sm:w-auto inline-flex rounded-lg">
            <TabsTrigger value="compress" className="gap-2 rounded-md text-zinc-400 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm font-medium">
              <Gauge className="h-3.5 w-3.5" /> Compress
            </TabsTrigger>
            <TabsTrigger value="convert" className="gap-2 rounded-md text-zinc-400 data-[state=active]:bg-white data-[state=active]:text-black data-[state=active]:shadow-sm font-medium">
              <Repeat2 className="h-3.5 w-3.5" /> Convert
            </TabsTrigger>
          </TabsList>

          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_0.65fr] gap-6 items-start">
            {/* Left: Tool panel - premium black card */}
            <Card className="border-white/[0.06] bg-[#111111] overflow-hidden shadow-[0_1px_0_0_rgba(255,255,255,0.03)_inset,0_1px_20px_rgba(0,0,0,0.4)]">
              <CardContent className="p-5 md:p-6 space-y-5">
                <button
                  onClick={selectFile}
                  className={`w-full flex items-center gap-4 rounded-xl border p-5 text-left transition-all ${file ? 'border-white/15 bg-white/[0.04] hover:bg-white/[0.06]' : 'border-dashed border-white/10 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15'}`}
                >
                  <div className={`h-12 w-12 shrink-0 grid place-items-center rounded-lg border ${file ? 'bg-white text-black border-white' : 'bg-[#0a0a0a] text-zinc-400 border-white/10'}`}>{file ? selectedIcon : <Upload className="h-5 w-5" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium text-zinc-100">{file ? file.name : 'Select image or video'}</div>
                    <div className="truncate text-xs text-zinc-500 mt-1 font-normal">{file ? `${file.kind.toUpperCase()} • ${file.extension.toUpperCase()} • ${file.sizeLabel}` : 'JPG, PNG, WEBP, MP4, MOV, MKV, AVI, WEBM'}</div>
                  </div>
                </button>

                {file && (
                  <Button variant="ghost" size="sm" onClick={removeCurrentFile} className="h-7 text-zinc-500 hover:text-zinc-200 hover:bg-white/5 -mt-2 text-xs">
                    <Trash2 className="h-3.5 w-3.5" /> Remove file
                  </Button>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {tab === 'compress' && (
                    <div className="space-y-2">
                      <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Max output size</Label>
                      <div className="flex gap-2">
                        <Input type="number" min="0.1" step="0.1" value={maxSizeMB} onChange={(e) => setMaxSizeMB(Number(e.target.value))} className="bg-[#0a0a0a] border-white/10 focus-visible:border-white/20 focus-visible:ring-white/10" />
                        <span className="inline-flex h-9 items-center rounded-md border border-white/10 bg-zinc-900 px-3 text-xs font-medium text-zinc-400">MB</span>
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output format</Label>
                    <Select value={format} onValueChange={setFormat}>
                      <SelectTrigger className="bg-[#0a0a0a] border-white/10"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-[#141414] border-white/10">
                        {formats.map((item) => (
                          <SelectItem key={item} value={item}>{item.toUpperCase()}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output name</Label>
                    <Input value={outputName} onChange={(e) => setOutputName(e.target.value)} placeholder="Leave blank to auto-name" className="bg-[#0a0a0a] border-white/10 focus-visible:border-white/20 placeholder:text-zinc-600" />
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <Label className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">Output folder</Label>
                    <div className="flex gap-2">
                      <Input value={outputDir || 'Same as source file'} readOnly className="bg-[#0a0a0a] border-white/10 text-zinc-500" />
                      <Button type="button" onClick={selectOutputDir} size="icon" className="shrink-0 bg-white text-black hover:bg-zinc-200 border border-white">
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
                  <Progress value={progress} className="h-1.5 bg-zinc-900 [&>div]:bg-white" />
                </div>

                <Button onClick={runJob} disabled={busy || !ffmpegReady} className="w-full h-[44px] text-[13px] font-semibold bg-white text-black hover:bg-zinc-200 shadow-[0_1px_0_rgba(255,255,255,0.1)_inset] disabled:opacity-40">
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  {busy ? 'Working...' : actionLabel}
                </Button>

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
                      <div className="h-8 w-8 grid place-items-center rounded-full bg-white text-black shrink-0">
                        <CheckCircle2 className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-sm text-zinc-100 truncate">{result.outputName}</div>
                        <div className="text-xs text-zinc-500 mt-1 flex items-center gap-1.5">{result.sizeLabel} <span className="h-1 w-1 rounded-full bg-white/20" /> <span className="inline-flex items-center rounded-full px-2 py-0.5 bg-zinc-800 border border-white/10 text-zinc-300 text-[11px] font-medium">Completed</span></div>
                      </div>
                    </div>
                    <code className="block rounded-lg bg-[#141414] p-3 text-xs break-all text-zinc-400 border border-white/10 font-mono">{result.outputPath}</code>
                    <Button onClick={openResultFolder} className="w-full bg-white text-black hover:bg-zinc-200">
                      <ExternalLink className="h-4 w-4" /> Show in folder
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.02] p-8 text-center space-y-2">
                    <div className="text-[11px] font-medium uppercase tracking-widest text-zinc-500">{tab === 'compress' ? 'Target size preview' : 'Format preview'}</div>
                    <div className="text-sm font-medium text-zinc-200">{file ? `${file.name} → ${format.toUpperCase()}` : 'Waiting for a file'}</div>
                    <div className="text-xs text-zinc-600">Select a file to see output details</div>
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

      <footer className="h-9 flex items-center justify-between px-6 border-t border-white/[0.06] bg-[#050505] text-[11px] tracking-wide text-zinc-600 shrink-0">
        <span className="hidden sm:inline font-medium">Version 2.1</span>
        <span className="mx-auto font-medium">
          SmoothOps © 2026 • NEXPRO AI LLP • All Rights Reserved.
        </span>
        <span className="hidden sm:flex items-center gap-1">made with <Heart className="h-3 w-3 fill-zinc-700 text-zinc-700" /> by gourav soni</span>
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
