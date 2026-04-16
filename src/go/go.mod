module github.com/EDM115/monorepo-hash/src/go

go 1.26

tool (
	github.com/josephspurrier/goversioninfo/cmd/goversioninfo
	honnef.co/go/tools/cmd/staticcheck
)

require (
	github.com/bmatcuk/doublestar/v4 v4.10.0
	github.com/go-git/go-git/v6 v6.0.0-alpha.1
	go.yaml.in/yaml/v4 v4.0.0-rc.4
)

require (
	github.com/BurntSushi/toml v1.6.0 // indirect
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/go-git/gcfg/v2 v2.0.2 // indirect
	github.com/go-git/go-billy/v6 v6.0.0-20260410103409-85b6241850b5 // indirect
	github.com/josephspurrier/goversioninfo v1.5.0 // indirect
	golang.org/x/exp/typeparams v0.0.0-20260410095643-746e56fc9e2f // indirect
	golang.org/x/mod v0.35.0 // indirect
	golang.org/x/sync v0.20.0 // indirect
	golang.org/x/tools v0.44.0 // indirect
	honnef.co/go/tools v0.7.0 // indirect
)
