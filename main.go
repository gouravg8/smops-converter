package main

import (
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "SmoothOps Converter",
		Width:            1280,
		Height:           800,
		MinWidth:         980,
		MinHeight:        640,
		WindowStartState: options.Maximised,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			CSSDropProperty:    "--wails-drop-target",
			CSSDropValue:       "drop",
			DisableWebViewDrop: false,
		},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 8, G: 8, B: 8, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
		Linux: &linux.Options{
			Icon:        appIcon,
			ProgramName: "SmoothOps Converter",
		},
		Mac: &mac.Options{
			About: &mac.AboutInfo{
				Title:   "SmoothOps Converter",
				Message: "© 2026 NEXPRO AI LLP. All Rights Reserved.\nSmoothOps media converter — compress and convert images and videos",
				Icon:    appIcon,
			},
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
