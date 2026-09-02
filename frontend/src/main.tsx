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
import './style.css';
import { appApi, FileInfo, ProcessResult } from './wails';
import { EventsOff, EventsOn } from '../wailsjs/runtime/runtime';

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
      const nextResult =
        tab === 'compress' ? await appApi().Compress(payload) : await appApi().Convert(payload);
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

  const selectedIcon = file?.kind === 'video' ? <FileVideo size={28} /> : <FileImage size={28} />;
  const actionLabel = tab === 'compress' ? 'Compress file' : 'Convert format';

  return (
    <main className="app-shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Desktop media utility</p>
            <h1>Gonver</h1>
          </div>
          <div className={ffmpegReady ? 'status ready' : 'status missing'}>
            <span />
            {ffmpegReady ? 'FFmpeg ready' : 'FFmpeg missing'}
          </div>
        </header>

        <nav className="tabs" aria-label="Tool tabs">
          <button className={tab === 'compress' ? 'active' : ''} onClick={() => setTab('compress')}>
            <Gauge size={18} />
            Compress
          </button>
          <button className={tab === 'convert' ? 'active' : ''} onClick={() => setTab('convert')}>
            <Repeat2 size={18} />
            Convert
          </button>
        </nav>

        <div className="panel-grid">
          <section className="tool-panel">
            <button className="dropzone" onClick={selectFile}>
              <div className="file-mark">{file ? selectedIcon : <Upload size={30} />}</div>
              <div>
                <strong>{file ? file.name : 'Select image or video'}</strong>
                <span>
                  {file
                    ? `${file.kind.toUpperCase()} / ${file.extension.toUpperCase()} / ${file.sizeLabel}`
                    : 'JPG, PNG, WEBP, MP4, MOV, MKV, AVI, WEBM'}
                </span>
              </div>
            </button>

            {file && (
              <button className="remove-file" onClick={removeCurrentFile}>
                <Trash2 size={17} />
                Remove current file
              </button>
            )}

            <div className="form-grid">
              {tab === 'compress' && (
                <label>
                  Max output size
                  <div className="input-row">
                    <input
                      min="0.1"
                      step="0.1"
                      type="number"
                      value={maxSizeMB}
                      onChange={(event) => setMaxSizeMB(Number(event.target.value))}
                    />
                    <span>MB</span>
                  </div>
                </label>
              )}

              <label>
                Output format
                <select value={format} onChange={(event) => setFormat(event.target.value)}>
                  {formats.map((item) => (
                    <option key={item} value={item}>
                      {item.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              <label className="wide">
                Output name
                <input
                  value={outputName}
                  onChange={(event) => setOutputName(event.target.value)}
                  placeholder="Leave blank to auto-name the file"
                />
              </label>

              <label className="wide">
                Output folder
                <div className="folder-row">
                  <input value={outputDir || 'Same as source file'} readOnly />
                  <button onClick={selectOutputDir} title="Choose output folder">
                    <FolderOpen size={18} />
                  </button>
                </div>
              </label>
            </div>

            <div className="progress-wrap" aria-label="Job progress">
              <div className="progress-meta">
                <span>{progressStage}</span>
                <strong>{progress}%</strong>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>

            {!ffmpegReady && (
              <button className="secondary-action" onClick={installFFmpeg} disabled={installingFFmpeg}>
                {installingFFmpeg ? <Loader2 className="spin" size={18} /> : <PackagePlus size={18} />}
                {installingFFmpeg ? 'Installing FFmpeg...' : 'Install FFmpeg'}
              </button>
            )}

            <button className="primary-action" onClick={runJob} disabled={busy || !ffmpegReady}>
              {busy ? <Loader2 className="spin" size={20} /> : <Download size={20} />}
              {busy ? 'Working...' : actionLabel}
            </button>
          </section>

          <aside className="result-panel">
            <h2>{tab === 'compress' ? 'Compression output' : 'Conversion output'}</h2>
            {result ? (
              <div className="result-card">
                <CheckCircle2 size={30} />
                <strong>{result.outputName}</strong>
                <span>{result.sizeLabel}</span>
                <code>{result.outputPath}</code>
                <button className="open-folder" onClick={openResultFolder}>
                  <ExternalLink size={17} />
                  Show in folder
                </button>
              </div>
            ) : (
              <div className="empty-result">
                <span>{tab === 'compress' ? 'Target size preview' : 'Format preview'}</span>
                <strong>
                  {file ? `${file.name} -> ${format.toUpperCase()}` : 'Waiting for a file'}
                </strong>
              </div>
            )}
            {error && <p className="error">{error}</p>}
          </aside>
        </div>
      </section>

      <footer>
        made with love <Heart size={15} fill="currentColor" /> by gourav soni
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

function suggestOutputName(fileName: string, mode: 'compress' | 'convert') {
  const dotIndex = fileName.lastIndexOf('.');
  const baseName = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  return `${baseName}-${mode === 'compress' ? 'compressed' : 'converted'}`;
}
