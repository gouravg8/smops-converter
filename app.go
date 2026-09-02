package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

type App struct {
	ctx context.Context
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

func (a *App) CheckFFmpeg() bool {
	return hasCommand("ffmpeg") && hasCommand("ffprobe")
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
		if !hasCommand("winget") {
			runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html")
			return errors.New("winget is not available; opened the FFmpeg download page")
		}
		a.emitProgress(12, "Installing FFmpeg")
		cmd := exec.Command(
			"winget",
			"install",
			"--id", "Gyan.FFmpeg",
			"-e",
			"--accept-package-agreements",
			"--accept-source-agreements",
		)
		hideCommandWindow(cmd)
		output, err := cmd.CombinedOutput()
		if err != nil {
			runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html")
			return fmt.Errorf("FFmpeg install failed: %s", strings.TrimSpace(string(output)))
		}
		a.emitProgress(100, "FFmpeg installed")
		return nil
	case "darwin":
		runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-mac")
	default:
		runtime.BrowserOpenURL(a.ctx, "https://ffmpeg.org/download.html#build-linux")
	}
	return errors.New("opened FFmpeg install instructions for this OS")
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

	if info.Kind == "image" {
		err = a.processImage(req.InputPath, outPath, format, req.MaxSizeMB, req.Mode == "compress")
	} else if info.Kind == "video" {
		err = a.processVideo(req.InputPath, outPath, format, req.MaxSizeMB, req.Mode == "compress")
	} else {
		err = errors.New("unsupported file type")
	}
	if err != nil {
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
	targetBytes := int64(maxMB * 1024 * 1024)
	if !enforceSize {
		a.emitProgress(20, "Converting image")
		args := []string{"-y", "-i", input, "-frames:v", "1"}
		args = append(args, imageCodecArgs(format)...)
		args = append(args, output)
		if err := runFFmpeg(args...); err != nil {
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
			attempt++
			a.emitProgress(8+int(float64(attempt)/float64(totalAttempts)*86), "Compressing image")
			args := []string{"-y", "-i", input, "-frames:v", "1"}
			if scale < 100 {
				args = append(args, "-vf", fmt.Sprintf("scale=iw*%0.2f:ih*%0.2f", float64(scale)/100, float64(scale)/100))
			}
			args = append(args, imageCompressionArgs(format, q)...)
			args = append(args, output)
			if err := runFFmpeg(args...); err != nil {
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
		return a.runFFmpegWithProgress(duration, args...)
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
		return errors.New("target file size is too small for this video's duration")
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
	return a.runFFmpegWithProgress(duration, args...)
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
	cmd := exec.Command("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input)
	hideCommandWindow(cmd)
	output, err := cmd.Output()
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
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
