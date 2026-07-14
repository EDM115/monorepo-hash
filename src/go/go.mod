module github.com/EDM115/monorepo-hash/src/go

go 1.26

tool (
	github.com/josephspurrier/goversioninfo/cmd/goversioninfo
	honnef.co/go/tools/cmd/staticcheck
)

require (
	github.com/bmatcuk/doublestar/v4 v4.10.0
	github.com/go-git/go-git/v6 v6.0.0-alpha.4
	go.yaml.in/yaml/v4 v4.0.0-rc.6
)

require (
	github.com/BurntSushi/toml v1.6.0 // indirect
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/go-git/gcfg/v2 v2.0.2 // indirect
	github.com/go-git/go-billy/v6 v6.0.0-alpha.1 // indirect
	github.com/josephspurrier/goversioninfo v1.7.0 // indirect
	golang.org/x/exp/typeparams v0.0.0-20260709172345-9ea1abe57597 // indirect
	golang.org/x/mod v0.38.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/tools v0.48.0 // indirect
	honnef.co/go/tools v0.7.0 // indirect
)
