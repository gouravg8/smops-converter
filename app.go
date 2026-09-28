package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const AppVersion = "0.0.2"

// Change this to your hosted version.json (S3/GitHub Pages/Raw). Windows installer URL is per-platform.
const UpdateManifestURL = "https://raw.githubusercontent.com/gouravg8/smops-converter/main/updates/windows/latest.json"

type UpdateInfo struct {
	Available       bool   `json:"available"`
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	URL             string `json:"url"`
	Notes           string `json:"notes"`
	Mandatory       bool   `json:"mandatory"`
	PublishedAt     string `json:"publishedAt"`
}

type App struct {
	ctx        context.Context
	mu         sync.Mutex
	currentCmd *exec.Cmd
	cancelFunc context.CancelFunc
}

type FileInfo struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	Extension string `json:"extension"`
	Kind      string `json:"kind"`
	SizeBytes int64  `json:"sizeBytes"`
	SizeLabel string `json:"sizeLabel"`
}

type ProcessRequest struct {
	InputPath  string  `json:"inputPath"`
	OutputDir  string  `json:"outputDir"`
	OutputName string  `json:"outputName"`
	Format     string  `json:"format"`
	MaxSizeMB  float64 `json:"maxSizeMB"`
	Mode       string  `json:"mode"`
}

type ProcessResult struct {
	OutputPath string `json:"outputPath"`
	OutputName string `json:"outputName"`
	SizeBytes  int64  `json:"sizeBytes"`
	SizeLabel  string `json:"sizeLabel"`
	Message    string `json:"message"`
}

type ProgressEvent struct {
	Percent int    `json:"percent"`
	Stage   string `json:"stage"`
}

func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	runtime.OnFileDrop(ctx, func(x, y int, paths []string) {
		if len(paths) == 0 {
			return
		}
		info, err := inspectFile(paths[0])
		if err != nil {
			runtime.EventsEmit(ctx, "file-dropped-error", err.Error())
			return
		}
		runtime.EventsEmit(ctx, "file-dropped", info)
	})
}

func (a *App) GetFileInfo(path string) (*FileInfo, error) {
	return inspectFile(path)
}

func (a *App) SelectFile() (*FileInfo, error) {
	path, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose an image or video",
		Filters: []runtime.FileFilter{
			{
				DisplayName: "Images and videos",
				Pattern:     "*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tiff;*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v",
			},
			{DisplayName: "Images", Pattern: "*.jpg;*.jpeg;*.png;*.webp;*.gif;*.bmp;*.tiff"},
			{DisplayName: "Videos", Pattern: "*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, nil
	}
	return inspectFile(path)
}

func (a *App) SelectOutputDir() (string, error) {
	return runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "Choose output folder",
	})
}

func (a *App) Compress(req ProcessRequest) (*ProcessResult, error) {
	req.Mode = "compress"
	if req.MaxSizeMB <= 0 {
		return nil, errors.New("enter a max output size greater than 0 MB")
	}
	return a.process(req)
}

func (a *App) Convert(req ProcessRequest) (*ProcessResult, error) {
	req.Mode = "convert"
	return a.process(req)
}

func (a *App) GetAppVersion() string { return AppVersion }

func (a *App) CheckFFmpeg() bool {
	return hasCommand("ffmpeg") && hasCommand("ffprobe")
}

func (a *App) CheckForUpdate() (*UpdateInfo, error) {
	info, err := fetchRemoteVersion(UpdateManifestURL)
	if err != nil {
		return nil, err
	}
	current := strings.TrimSpace(AppVersion)
	latest := strings.TrimSpace(info.LatestVersion)
	available := latest != "" && compareVersions(latest, current) > 0
	if !available {
		return &UpdateInfo{Available: false, CurrentVersion: current, LatestVersion: latest}, nil
	}
	info.Available = true
	info.CurrentVersion = current
	// emit event so frontend can react even if not polling return value
	runtime.EventsEmit(a.ctx, "update-available", info)
	return info, nil
}

func (a *App) DownloadAndInstallUpdate(url string) error {
	if strings.TrimSpace(url) == "" {
		return errors.New("empty update url")
	}
	a.emitProgress(2, "Downloading update")
	// download to temp
	tmpDir := os.TempDir()
	ext := ".exe"
	if goruntime.GOOS != "windows" {
		ext = ".bin"
	}
	tmpFile := filepath.Join(tmpDir, fmt.Sprintf("SmoothOps-Update-%d%s", time.Now().Unix(), ext))
	out, err := os.Create(tmpFile)
	if err != nil {
		return err
	}
	resp, err := http.Get(url) // #nosec G107 - url is from trusted manifest
	if err != nil {
		_ = out.Close()
		_ = os.Remove(tmpFile)
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		_ = out.Close()
		_ = os.Remove(tmpFile)
		return fmt.Errorf("download failed: %s", resp.Status)
	}
	// stream with progress if ContentLength known
	var total int64 = resp.ContentLength
	var written int64
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				_ = out.Close()
				_ = os.Remove(tmpFile)
				return werr
			}
			written += int64(n)
			if total > 0 {
				pct := int(float64(written) / float64(total) * 90) // 0-90 for download
				a.emitProgress(5+pct, "Downloading update")
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			_ = out.Close()
			_ = os.Remove(tmpFile)
			return readErr
		}
	}
	_ = out.Close()
	// make executable on unix
	if goruntime.GOOS != "windows" {
		_ = os.Chmod(tmpFile, 0755)
	}
	a.emitProgress(98, "Launching installer")
	// launch installer detached
	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		// NSIS installer: /S silent? we launch visible so user sees UAC
		cmd = exec.Command("cmd", "/c", "start", "", tmpFile)
	case "darwin":
		cmd = exec.Command("open", tmpFile)
	default:
		// Linux: xdg-open the binary or AppImage; user will manually replace
		cmd = exec.Command("xdg-open", tmpFile)
	}
	hideCommandWindow(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	a.emitProgress(100, "Update started — installer launched")
	// optionally quit app so installer can replace binary on Windows
	go func() {
		time.Sleep(800 * time.Millisecond)
		runtime.Quit(a.ctx)
	}()
	return nil
}

func fetchRemoteVersion(url string) (*UpdateInfo, error) {
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("update check failed: %s", resp.Status)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Version     string `json:"version"`
		LatestVersion string `json:"latestVersion"`
		URL         string `json:"url"`
		Notes       string `json:"notes"`
		Mandatory   bool   `json:"mandatory"`
		PublishedAt string `json:"publishedAt"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	version := raw.Version
	if version == "" {
		version = raw.LatestVersion
	}
	return &UpdateInfo{
		LatestVersion: strings.TrimSpace(version),
		URL:           strings.TrimSpace(raw.URL),
		Notes:         raw.Notes,
		Mandatory:     raw.Mandatory,
		PublishedAt:   raw.PublishedAt,
	}, nil
}

func compareVersions(a, b string) int {
	pa := parseVersionParts(a)
	pb := parseVersionParts(b)
	n := len(pa)
	if len(pb) > n {
		n = len(pb)
	}
	for i := 0; i < n; i++ {
		var av, bv int
		if i < len(pa) {
			av = pa[i]
		}
		if i < len(pb) {
			bv = pb[i]
		}
		if av < bv {
			return -1
		}
		if av > bv {
			return 1
		}
	}
	return 0
}

func parseVersionParts(v string) []int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	parts := strings.Split(v, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		// strip pre-release suffix like -beta
		if idx := strings.Index(p, "-"); idx >= 0 {
			p = p[:idx]
		}
		num, _ := strconv.Atoi(p)
		out = append(out, num)
	}
	return out
}

func (a *App) OpenInFolder(path string) error {
	if path == "" {
		return errors.New("no output file to open")
	}
	if _, err := os.Stat(path); err != nil {
		return err
	}

	var cmd *exec.Cmd
	switch goruntime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", "/select,", path)
	case "darwin":
		cmd = exec.Command("open", "-R", path)
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(path))
	}
	return cmd.Start()
}

func (a *App) InstallFFmpeg() error {
	if a.CheckFFmpeg() {
		return nil
	}

	a.emitProgress(4, "Checking installer")
	switch goruntime.GOOS {
	case "windows":
		return a.installWindowsFFmpeg()
	case "darwin":
		return a.installMacFFmpeg()
	default:
		return a.installLinuxFFmpeg()
	}
}

func (a *App) installWindowsFFmpeg() error {
	// 1) winget (preferred)
	if hasCommand("winget") {
		a.emitProgress(12, "Installing FFmpeg via winget")
		cmd := exec.Command("winget", "install", "--id", "Gyan.FFmpeg", "-e", "--accept-package-agreements", "--accept-source-agreements")
		hideCommandWindow(cmd)
		output, err := cmd.CombinedOutput()
		if err == nil {
			a.emitProgress(100, "FFmpeg installed")
			if a.CheckFFmpeg() {
				return nil
			}
		} else {
			// winget failed, fall through to wget/powershell
			a.emitProgress(20, fmt.Sprintf("winget failed, trying PowerShell: %s", strings.TrimSpace(string(output))))
		}
	}
	// 2) PowerShell wget (Invoke-WebRequest) fallback — download Gyan essentials build
	if hasCommand("powershell") || hasCommand("pwsh") {
		pwsh := "powershell"
		if hasCommand("pwsh") {
			pwsh = "pwsh"
		}
		a.emitProgress(30, "Downloading FFmpeg via PowerShell wget")
		// Use BtbN or Gyan release via direct URL; use BtbN latest as example
		script := `$ProgressPreference='SilentlyContinue'; $url='https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'; $zip="$env:TEMP\\ffmpeg.zip"; $dest="$env:LOCALAPPDATA\\ffmpeg"; try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; Expand-Archive -Path $zip -DestinationPath $dest -Force; $bin=(Get-ChildItem -Path $dest -Recurse -Filter ffmpeg.exe | Select-Object -First 1).DirectoryName; $old=[Environment]::GetEnvironmentVariable('Path','User'); if($bin -and $old -notlike "*$bin*"){ [Environment]::SetEnvironmentVariable('Path', \"$old;$bin\", 'User'); $env:Path += \";$bin\" }; exit 0 } catch { Write-Error $_.Exception.Message; exit 1 }`
		cmd := exec.Command(pwsh, "-NoProfile", "-Command", script)
		hideCommandWindow(cmd)
		output, err := cmd.CombinedOutput()
		if err == nil && a.CheckFFmpeg() {
			a.emitProgress(100, "FFmpeg installed via PowerShell")
			return nil
		}
		if err != nil {
			runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html")
			return fmt.Errorf("PowerShell install failed: %s", strings.TrimSpace(string(output)))
		}
	}
	runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html")
	return errors.New("winget/powershell not available; opened FFmpeg download page")
}

func (a *App) installMacFFmpeg() error {
	// brew (preferred on macOS)
	if hasCommand("brew") {
		a.emitProgress(12, "Installing FFmpeg via brew")
		cmd := exec.Command("brew", "install", "ffmpeg")
		hideCommandWindow(cmd)
		output, err := cmd.CombinedOutput()
		if err == nil && a.CheckFFmpeg() {
			a.emitProgress(100, "FFmpeg installed via brew")
			return nil
		}
		if err != nil {
			// keep trying fallback
			a.emitProgress(30, fmt.Sprintf("brew failed: %s", strings.TrimSpace(string(output))))
		}
	}
	if hasCommand("port") {
		a.emitProgress(12, "Installing FFmpeg via MacPorts")
		cmd := exec.Command("port", "install", "ffmpeg")
		hideCommandWindow(cmd)
		if out, err := cmd.CombinedOutput(); err == nil && a.CheckFFmpeg() {
			a.emitProgress(100, "FFmpeg installed via MacPorts")
			return nil
		} else {
			a.emitProgress(30, fmt.Sprintf("port failed: %s", strings.TrimSpace(string(out))))
		}
	}
	runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-mac")
	if !hasCommand("brew") {
		return errors.New("brew not found; opened FFmpeg install page — install with: /bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\" && brew install ffmpeg")
	}
	return errors.New("brew install failed; opened FFmpeg download page")
}

func (a *App) installLinuxFFmpeg() error {
	// Detect package manager: apt (Ubuntu/Debian), dnf (Fedora), yum, pacman (Arch), zypper (openSUSE)
	var pm string
	var updateArgs, installArgs []string
	switch {
	case hasCommand("apt-get"):
		pm = "apt-get"
		updateArgs = []string{"update"}
		installArgs = []string{"install", "-y", "ffmpeg"}
	case hasCommand("apt"):
		pm = "apt"
		updateArgs = []string{"update"}
		installArgs = []string{"install", "-y", "ffmpeg"}
	case hasCommand("dnf"):
		pm = "dnf"
		installArgs = []string{"install", "-y", "ffmpeg"}
	case hasCommand("yum"):
		pm = "yum"
		installArgs = []string{"install", "-y", "ffmpeg"}
	case hasCommand("pacman"):
		pm = "pacman"
		updateArgs = []string{"-Sy"}
		installArgs = []string{"-S", "--noconfirm", "ffmpeg"}
	case hasCommand("zypper"):
		pm = "zypper"
		installArgs = []string{"install", "-y", "ffmpeg"}
	default:
		runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-linux")
		return errors.New("no supported package manager found (apt/dnf/pacman/zypper); opened FFmpeg download page")
	}

	// Try privileged execution: pkexec (GUI) -> sudo -> direct
	privPrefixes := [][]string{}
	if hasCommand("pkexec") {
		privPrefixes = append(privPrefixes, []string{"pkexec"})
	}
	if hasCommand("sudo") {
		privPrefixes = append(privPrefixes, []string{"sudo", "-n"})
		privPrefixes = append(privPrefixes, []string{"sudo"})
	}
	privPrefixes = append(privPrefixes, []string{}) // try without prefix as last resort

	tryRun := func(args []string) (string, error) {
		for _, prefix := range privPrefixes {
			full := append([]string{}, prefix...)
			full = append(full, pm)
			full = append(full, args...)
			cmd := exec.Command(full[0], full[1:]...)
			hideCommandWindow(cmd)
			out, err := cmd.CombinedOutput()
			if err == nil {
				return string(out), nil
			}
			// if permission denied without prompt, try next prefix
			msg := strings.ToLower(string(out))
			if strings.Contains(msg, "no askpass") || strings.Contains(msg, "a password is required") || strings.Contains(msg, "not allowed") {
				continue
			}
			// for pkexec cancelled, stop
			if strings.Contains(msg, "dismissed") || strings.Contains(msg, "cancelled") {
				return string(out), err
			}
			// otherwise return error for this manager
			return string(out), err
		}
		return "", errors.New("no privilege escalation succeeded")
	}

	if len(updateArgs) > 0 {
		a.emitProgress(12, fmt.Sprintf("Updating packages via %s", pm))
		if out, err := tryRun(updateArgs); err != nil {
			// non-fatal for some managers, continue to install
			a.emitProgress(20, fmt.Sprintf("%s update warning: %s", pm, strings.TrimSpace(out)))
		}
	}
	a.emitProgress(40, fmt.Sprintf("Installing FFmpeg via %s", pm))
	out, err := tryRun(installArgs)
	if err != nil {
		runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-linux")
		return fmt.Errorf("%s install failed: %s", pm, strings.TrimSpace(out))
	}
	a.emitProgress(80, "Verifying FFmpeg")
	if !a.CheckFFmpeg() {
		runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-linux")
		return fmt.Errorf("%s reported success but ffmpeg not found in PATH", pm)
	}
	a.emitProgress(100, "FFmpeg installed")
	return nil
}

const errVideoNeedsRepairPrefix = "VIDEO_NEEDS_REPAIR::"

func (a *App) RepairVideo(inputPath string) (*FileInfo, error) {
	if strings.TrimSpace(inputPath) == "" {
		return nil, errors.New("select a file first")
	}
	if !a.CheckFFmpeg() {
		return nil, errors.New("ffmpeg and ffprobe are required to repair videos")
	}
	info, err := inspectFile(inputPath)
	if err != nil {
		return nil, err
	}
	if info.Kind != "video" {
		return nil, errors.New("only video files need repairing")
	}

	dir := filepath.Dir(inputPath)
	ext := normalizeFormat(info.Extension)
	if ext == "" {
		ext = "mp4"
	}
	base := strings.TrimSuffix(info.Name, filepath.Ext(info.Name)) + "-fixed"
	fixedPath := uniqueOutputPath(dir, sanitizeFileName(base), ext)

	baseCtx := a.ctx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	jobCtx, cancel := context.WithCancel(baseCtx)
	a.mu.Lock()
	a.cancelFunc = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.cancelFunc = nil
		a.currentCmd = nil
		a.mu.Unlock()
		cancel()
	}()

	a.emitProgress(10, "Repairing video")
	// Fast remux: no re-encode, just rebuilds the container so duration/index is rewritten.
	args := []string{"-y", "-i", inputPath, "-c", "copy", "-movflags", "+faststart", fixedPath}
	if err := a.runFFmpegWithCtx(jobCtx, args...); err != nil {
		if errors.Is(err, context.Canceled) || jobCtx.Err() == context.Canceled {
			_ = os.Remove(fixedPath)
			return nil, errors.New("cancelled")
		}
		_ = os.Remove(fixedPath)
		return nil, err
	}
	if d, err := probeDuration(fixedPath); err != nil || d <= 0 {
		_ = os.Remove(fixedPath)
		return nil, errors.New("repair finished but the video duration is still unreadable — the file may be corrupted")
	}
	a.emitProgress(100, "Video repaired")
	return inspectFile(fixedPath)
}

func (a *App) Cancel() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancelFunc != nil {
		a.cancelFunc()
	}
	if a.currentCmd != nil && a.currentCmd.Process != nil {
		_ = a.currentCmd.Process.Kill()
	}
	return nil
}

func (a *App) process(req ProcessRequest) (*ProcessResult, error) {
	if req.InputPath == "" {
		return nil, errors.New("select a file first")
	}
	if req.Format == "" {
		return nil, errors.New("choose an output format")
	}
	if !a.CheckFFmpeg() {
		return nil, errors.New("ffmpeg and ffprobe are required for compression and conversion")
	}

	info, err := inspectFile(req.InputPath)
	if err != nil {
		return nil, err
	}
	if req.OutputDir == "" {
		req.OutputDir = filepath.Dir(req.InputPath)
	}
	if err := os.MkdirAll(req.OutputDir, 0755); err != nil {
		return nil, err
	}

	format := normalizeFormat(req.Format)
	baseName := outputBaseName(req.InputPath, req.OutputName, suffixForMode(req.Mode))
	outPath := uniqueOutputPath(req.OutputDir, baseName, format)
	a.emitProgress(4, "Preparing output")

	// cancellable context for this job
	jobCtx, cancel := context.WithCancel(a.ctx)
	a.mu.Lock()
	a.cancelFunc = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		a.cancelFunc = nil
		a.currentCmd = nil
		a.mu.Unlock()
		cancel()
	}()

	if info.Kind == "image" {
		err = a.processImageWithCtx(jobCtx, req.InputPath, outPath, format, req.MaxSizeMB, req.Mode == "compress")
	} else if info.Kind == "video" {
		err = a.processVideoWithCtx(jobCtx, req.InputPath, outPath, format, req.MaxSizeMB, req.Mode == "compress")
	} else {
		err = errors.New("unsupported file type")
	}
	if err != nil {
		if errors.Is(err, context.Canceled) {
			_ = os.Remove(outPath)
			return nil, errors.New("cancelled")
		}
		// for any other error, keep partial for debugging but stat will fail — remove broken file
		// try to leave file if exists; don't delete on genuine ffmpeg error
		return nil, err
	}

	stat, err := os.Stat(outPath)
	if err != nil {
		return nil, err
	}
	return &ProcessResult{
		OutputPath: outPath,
		OutputName: filepath.Base(outPath),
		SizeBytes:  stat.Size(),
		SizeLabel:  humanSize(stat.Size()),
		Message:    "Done",
	}, nil
}

func (a *App) emitProgress(percent int, stage string) {
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	runtime.EventsEmit(a.ctx, "job-progress", ProgressEvent{Percent: percent, Stage: stage})
}

func inspectFile(path string) (*FileInfo, error) {
	stat, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(path), "."))
	return &FileInfo{
		Path:      path,
		Name:      filepath.Base(path),
		Extension: ext,
		Kind:      mediaKind(ext),
		SizeBytes: stat.Size(),
		SizeLabel: humanSize(stat.Size()),
	}, nil
}

func (a *App) processImage(input, output, format string, maxMB float64, enforceSize bool) error {
	return a.processImageWithCtx(context.Background(), input, output, format, maxMB, enforceSize)
}

func (a *App) processImageWithCtx(ctx context.Context, input, output, format string, maxMB float64, enforceSize bool) error {
	targetBytes := int64(maxMB * 1024 * 1024)
	if !enforceSize {
		a.emitProgress(20, "Converting image")
		args := []string{"-y", "-i", input, "-frames:v", "1"}
		args = append(args, imageCodecArgs(format)...)
		args = append(args, output)
		if err := a.runFFmpegWithCtx(ctx, args...); err != nil {
			return err
		}
		a.emitProgress(100, "Complete")
		return nil
	}

	scales := []int{100, 90, 80, 70, 60, 50, 40}
	qualities := []int{2, 4, 6, 8, 10, 13, 16, 20, 24, 28, 31}
	totalAttempts := len(scales) * len(qualities)
	attempt := 0
	for _, scale := range scales {
		for _, q := range qualities {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
			}
			attempt++
			a.emitProgress(8+int(float64(attempt)/float64(totalAttempts)*86), "Compressing image")
			args := []string{"-y", "-i", input, "-frames:v", "1"}
			if scale < 100 {
				args = append(args, "-vf", fmt.Sprintf("scale=iw*%0.2f:ih*%0.2f", float64(scale)/100, float64(scale)/100))
			}
			args = append(args, imageCompressionArgs(format, q)...)
			args = append(args, output)
			if err := a.runFFmpegWithCtx(ctx, args...); err != nil {
				return err
			}
			if fileSize(output) <= targetBytes {
				a.emitProgress(100, "Complete")
				return nil
			}
		}
	}
	return fmt.Errorf("could not compress below %.2f MB without making the image too small", maxMB)
}

func (a *App) processVideo(input, output, format string, maxMB float64, enforceSize bool) error {
	return a.processVideoWithCtx(context.Background(), input, output, format, maxMB, enforceSize)
}

func (a *App) processVideoWithCtx(ctx context.Context, input, output, format string, maxMB float64, enforceSize bool) error {
	a.emitProgress(8, "Reading video")
	duration, err := probeDuration(input)
	if err != nil {
		return err
	}
	if duration <= 0 {
		return errors.New("could not read video duration")
	}

	if !enforceSize {
		args := []string{"-y", "-i", input}
		args = append(args, videoCodecArgs(format)...)
		args = append(args, output)
		return a.runFFmpegWithProgressCtx(ctx, duration, args...)
	}
	targetBits := maxMB * 1024 * 1024 * 8
	totalKbps := math.Floor((targetBits / duration) / 1000 * 0.92)
	audioKbps := 96.0
	videoKbps := totalKbps - audioKbps
	if videoKbps < 120 {
		audioKbps = 64
		videoKbps = totalKbps - audioKbps
	}
	if videoKbps < 80 {
		minKbps := 80.0 + 64.0
		minMB := (minKbps*1000*duration/0.92)/8/1024/1024
		minMB = math.Ceil(minMB*10) / 10
		if minMB < 0.5 {
			minMB = 0.5
		}
		return fmt.Errorf("target %.1f MB too small for %.0fs video (needs ≥80 kbps video + 64 kbps audio). Try at least %.1f MB or use Convert without size limit", maxMB, duration, minMB)
	}

	args := []string{"-y", "-i", input}
	args = append(args, videoCodecArgs(format)...)
	args = append(args,
		"-b:v", fmt.Sprintf("%.0fk", videoKbps),
		"-maxrate", fmt.Sprintf("%.0fk", videoKbps*1.25),
		"-bufsize", fmt.Sprintf("%.0fk", videoKbps*2),
		"-b:a", fmt.Sprintf("%.0fk", audioKbps),
		output,
	)
	return a.runFFmpegWithProgressCtx(ctx, duration, args...)
}

func (a *App) runFFmpegWithCtx(ctx context.Context, args ...string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	a.mu.Lock()
	a.currentCmd = cmd
	a.mu.Unlock()
	hideCommandWindow(cmd)
	output, err := cmd.CombinedOutput()
	a.mu.Lock()
	a.currentCmd = nil
	a.mu.Unlock()
	if ctx.Err() == context.Canceled {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("ffmpeg failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func (a *App) runFFmpegWithProgressCtx(ctx context.Context, duration float64, args ...string) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	progressArgs := append([]string{}, args[:len(args)-1]...)
	progressArgs = append(progressArgs, "-progress", "pipe:1", "-nostats", args[len(args)-1])
	cmd := exec.CommandContext(ctx, "ffmpeg", progressArgs...)
	a.mu.Lock()
	a.currentCmd = cmd
	a.mu.Unlock()
	hideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		a.mu.Lock()
		a.currentCmd = nil
		a.mu.Unlock()
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		a.mu.Lock()
		a.currentCmd = nil
		a.mu.Unlock()
		return err
	}
	scanner := bufio.NewScanner(stdout)
	a.emitProgress(12, "Processing video")
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			a.mu.Lock()
			a.currentCmd = nil
			a.mu.Unlock()
			return ctx.Err()
		default:
		}
		line := scanner.Text()
		if strings.HasPrefix(line, "out_time_ms=") {
			value := strings.TrimPrefix(line, "out_time_ms=")
			microseconds, parseErr := strconv.ParseFloat(value, 64)
			if parseErr == nil && duration > 0 {
				seconds := microseconds / 1000000
				percent := 12 + int((seconds/duration)*86)
				a.emitProgress(percent, "Processing video")
			}
		}
	}
	if err := scanner.Err(); err != nil {
		a.mu.Lock()
		a.currentCmd = nil
		a.mu.Unlock()
		return err
	}
	err = cmd.Wait()
	a.mu.Lock()
	a.currentCmd = nil
	a.mu.Unlock()
	if ctx.Err() == context.Canceled {
		return ctx.Err()
	}
	if err != nil {
		return fmt.Errorf("ffmpeg failed: %s", strings.TrimSpace(stderr.String()))
	}
	a.emitProgress(100, "Complete")
	return nil
}

func runFFmpeg(args ...string) error {
	cmd := exec.Command("ffmpeg", args...)
	hideCommandWindow(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg failed: %s", strings.TrimSpace(string(output)))
	}
	return nil
}

func (a *App) runFFmpegWithProgress(duration float64, args ...string) error {
	progressArgs := append([]string{}, args[:len(args)-1]...)
	progressArgs = append(progressArgs, "-progress", "pipe:1", "-nostats", args[len(args)-1])

	cmd := exec.Command("ffmpeg", progressArgs...)
	hideCommandWindow(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return err
	}

	scanner := bufio.NewScanner(stdout)
	a.emitProgress(12, "Processing video")
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "out_time_ms=") {
			value := strings.TrimPrefix(line, "out_time_ms=")
			microseconds, parseErr := strconv.ParseFloat(value, 64)
			if parseErr == nil && duration > 0 {
				seconds := microseconds / 1000000
				percent := 12 + int((seconds/duration)*86)
				a.emitProgress(percent, "Processing video")
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg failed: %s", strings.TrimSpace(stderr.String()))
	}
	a.emitProgress(100, "Complete")
	return nil
}

func probeDuration(input string) (float64, error) {
	// Try container duration first.
	if d, err := ffprobeDuration([]string{"-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input}); err == nil && d > 0 {
		return d, nil
	}
	// Fallback: longest stream duration (handles files where format duration is N/A,
	// e.g. fragmented MP4s, screen recordings, WhatsApp forwards).
	if d, err := ffprobeDuration([]string{"-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", input}); err == nil && d > 0 {
		return d, nil
	}
	if d, err := ffprobeDuration([]string{"-v", "error", "-show_entries", "stream=duration", "-of", "default=noprint_wrappers=1:nokey=1", input}); err == nil && d > 0 {
		return d, nil
	}
	return 0, errors.New(errVideoNeedsRepairPrefix + "This video's duration can't be read (header says N/A), so compression can't start. Click \"Fix video & retry\" — it rebuilds the file quickly without losing quality, then compresses the fixed copy.")
}

func ffprobeDuration(args []string) (float64, error) {
	cmd := exec.Command("ffprobe", args...)
	hideCommandWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}
	// ffprobe may print one line per stream or "N/A" — pick the largest numeric value.
	best := 0.0
	found := false
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "N/A" {
			continue
		}
		if v, err := strconv.ParseFloat(line, 64); err == nil && v > 0 && v > best {
			best = v
			found = true
		}
	}
	if !found {
		return 0, errors.New("no duration found")
	}
	return best, nil
}

func imageCodecArgs(format string) []string {
	return imageCompressionArgs(format, 4)
}

func imageCompressionArgs(format string, quality int) []string {
	switch format {
	case "jpg", "jpeg":
		return []string{"-q:v", strconv.Itoa(quality)}
	case "png":
		return []string{"-compression_level", "9", "-pred", "mixed"}
	case "webp":
		return []string{"-c:v", "libwebp", "-quality", strconv.Itoa(max(8, 95-quality*3))}
	default:
		return []string{}
	}
}

func videoCodecArgs(format string) []string {
	switch format {
	case "webm":
		return []string{"-c:v", "libvpx-vp9", "-c:a", "libopus"}
	case "mp4", "m4v":
		return []string{"-c:v", "libx264", "-preset", "medium", "-c:a", "aac", "-movflags", "+faststart"}
	case "mkv":
		return []string{"-c:v", "libx264", "-preset", "medium", "-c:a", "aac"}
	case "avi":
		return []string{"-c:v", "mpeg4", "-c:a", "mp3"}
	default:
		return []string{}
	}
}

func suffixForMode(mode string) string {
	if mode == "convert" {
		return "converted"
	}
	return "compressed"
}

func outputBaseName(input, requested, suffix string) string {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		return sanitizeFileName(strings.TrimSuffix(requested, filepath.Ext(requested)))
	}
	base := strings.TrimSuffix(filepath.Base(input), filepath.Ext(input))
	return sanitizeFileName(fmt.Sprintf("%s-%s", base, suffix))
}

func sanitizeFileName(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return "output"
	}
	replacer := strings.NewReplacer("\\", "-", "/", "-", ":", "-", "*", "-", "?", "-", "\"", "-", "<", "-", ">", "-", "|", "-")
	name = replacer.Replace(name)
	name = strings.Trim(name, ". ")
	if name == "" {
		return "output"
	}
	return name
}

func uniqueOutputPath(dir, base, format string) string {
	candidate := filepath.Join(dir, fmt.Sprintf("%s.%s", base, format))
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s-%d.%s", base, i, format))
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
}

func normalizeFormat(format string) string {
	format = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(format), "."))
	if format == "jpeg" {
		return "jpg"
	}
	return format
}

func mediaKind(ext string) string {
	switch ext {
	case "jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff":
		return "image"
	case "mp4", "mov", "mkv", "avi", "webm", "m4v":
		return "video"
	default:
		return "unknown"
	}
}

func humanSize(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	units := []string{"KB", "MB", "GB"}
	size := float64(bytes)
	for _, unit := range units {
		size /= 1024
		if size < 1024 {
			return fmt.Sprintf("%.2f %s", size, unit)
		}
	}
	return fmt.Sprintf("%.2f TB", size/1024)
}

func fileSize(path string) int64 {
	stat, err := os.Stat(path)
	if err != nil {
		return math.MaxInt64
	}
	return stat.Size()
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func init() {
	_ = time.Second
}
