module github.com/EDM115/monorepo-hash/src/go

go 1.26

tool (
	github.com/josephspurrier/goversioninfo/cmd/goversioninfo
	honnef.co/go/tools/cmd/staticcheck
)

require (
	github.com/bmatcuk/doublestar/v4 v4.10.0
	github.com/go-git/go-git/v6 v6.0.0-20260324221343-cd85c8c75d34
	go.yaml.in/yaml/v4 v4.0.0-rc.4
)

require (
	github.com/BurntSushi/toml v1.4.1-0.20240526193622-a339e1f7089c // indirect
	github.com/akavel/rsrc v0.10.2 // indirect
	github.com/go-git/gcfg/v2 v2.0.2 // indirect
	github.com/go-git/go-billy/v6 v6.0.0-20260226131633-45bd0956d66f // indirect
	github.com/josephspurrier/goversioninfo v1.5.0 // indirect
	golang.org/x/exp/typeparams v0.0.0-20231108232855-2478ac86f678 // indirect
	golang.org/x/mod v0.31.0 // indirect
	golang.org/x/sync v0.19.0 // indirect
	golang.org/x/tools v0.40.1-0.20260108161641-ca281cf95054 // indirect
	honnef.co/go/tools v0.7.0 // indirect
)
