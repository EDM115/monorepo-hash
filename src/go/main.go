package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
)

var packageManagers = []string{"pnpm", "npm", "deno", "bun", "yarn"}

type options struct {
	mode     string
	targets  []string
	silent   bool
	debug    bool
	unified  bool
	pmOption string
}

type detected struct {
	pm    string
	root  string
	globs []string
}

type packageManifest struct {
	Name             string            `json:"name"`
	Dependencies     map[string]string `json:"dependencies"`
	DevDependencies  map[string]string `json:"devDependencies"`
	PeerDependencies map[string]string `json:"peerDependencies"`
}

type pkgMeta struct {
	name   string
	dir    string
	relDir string
	deps   []string
}

type pkgInfo struct {
	dir           string
	relDir        string
	deps          []string
	perFileHashes map[string]string
	ownHash       []byte
}

type compareChanged struct {
	Name       string   `json:"name"`
	OldHash    string   `json:"oldHash"`
	NewHash    string   `json:"newHash"`
	ChangedDep []string `json:"changedDeps"`
}

type compareMissing struct {
	Name    string `json:"name"`
	NewHash string `json:"newHash"`
}

type compareResult struct {
	UnchangedTargets []string         `json:"unchangedTargets"`
	ChangedTargets   []compareChanged `json:"changedTargets"`
	MissingTargets   []compareMissing `json:"missingTargets"`
}

type rule struct {
	pattern  string
	negated  bool
	dirOnly  bool
	hasSlash bool
	anchored bool
	re       *regexp.Regexp
}

type ignoreMatcher struct {
	rules []rule
}

func (m *ignoreMatcher) shouldIgnore(rel string, isDir bool) bool {
	rel = toPosix(rel)
	if rel == "" {
		return false
	}
	ignored := false
	for _, r := range m.rules {
		if matchRule(r, rel, isDir) {
			ignored = !r.negated
		}
	}
	return ignored
}

func matchRule(r rule, rel string, isDir bool) bool {
	if r.dirOnly {
		if r.hasSlash {
			p := r.pattern
			if rel == p || strings.HasPrefix(rel, p+"/") || strings.Contains(rel, "/"+p+"/") {
				return true
			}
			if r.re != nil && r.re.MatchString(rel) {
				return true
			}
			return false
		}
		parts := strings.Split(rel, "/")
		for i, part := range parts {
			if matchSimplePattern(r.pattern, part) && (i < len(parts)-1 || isDir) {
				return true
			}
		}
		return false
	}

	if r.hasSlash {
		if r.re != nil && r.re.MatchString(rel) {
			return true
		}
		if !r.anchored {
			return strings.Contains(rel, "/"+r.pattern)
		}
		return false
	}

	parts := strings.Split(rel, "/")
	for _, part := range parts {
		if matchSimplePattern(r.pattern, part) {
			return true
		}
	}
	return false
}

func parseIgnore(content string) *ignoreMatcher {
	scanner := bufio.NewScanner(strings.NewReader(content))
	m := &ignoreMatcher{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		r := rule{}
		if strings.HasPrefix(line, "!") {
			r.negated = true
			line = strings.TrimPrefix(line, "!")
		}
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "/") {
			r.anchored = true
			line = strings.TrimPrefix(line, "/")
		}
		if strings.HasSuffix(line, "/") {
			r.dirOnly = true
			line = strings.TrimSuffix(line, "/")
		}
		line = toPosix(strings.TrimSpace(line))
		if line == "" {
			continue
		}
		r.pattern = line
		r.hasSlash = strings.Contains(line, "/")
		re, err := compileGlob(line, r.anchored)
		if err == nil {
			r.re = re
		}
		m.rules = append(m.rules, r)
	}
	return m
}

func compileGlob(glob string, anchored bool) (*regexp.Regexp, error) {
	var b strings.Builder
	if anchored {
		b.WriteString("^")
	} else {
		b.WriteString("(^|.*/)")
	}
	for i := 0; i < len(glob); i++ {
		ch := glob[i]
		switch ch {
		case '*':
			if i+1 < len(glob) && glob[i+1] == '*' {
				b.WriteString(".*")
				i++
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '.', '+', '(', ')', '[', ']', '{', '}', '^', '$', '|', '\\':
			b.WriteByte('\\')
			b.WriteByte(ch)
		default:
			b.WriteByte(ch)
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}

func matchSimplePattern(pattern, name string) bool {
	ok, err := path.Match(pattern, name)
	if err != nil {
		return pattern == name
	}
	return ok
}

func toPosix(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

func parseJSONC(input string) string {
	var out bytes.Buffer
	inString := false
	escaped := false
	inLineComment := false
	inBlockComment := false

	for i := 0; i < len(input); i++ {
		c := input[i]
		next := byte(0)
		if i+1 < len(input) {
			next = input[i+1]
		}

		if inLineComment {
			if c == '\n' {
				inLineComment = false
				out.WriteByte(c)
			}
			continue
		}
		if inBlockComment {
			if c == '*' && next == '/' {
				inBlockComment = false
				i++
			}
			continue
		}
		if inString {
			out.WriteByte(c)
			if escaped {
				escaped = false
				continue
			}
			if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		if c == '"' {
			inString = true
			out.WriteByte(c)
			continue
		}
		if c == '/' && next == '/' {
			inLineComment = true
			i++
			continue
		}
		if c == '/' && next == '*' {
			inBlockComment = true
			i++
			continue
		}
		out.WriteByte(c)
	}
	return out.String()
}

func isPackageManager(value string) bool {
	for _, pm := range packageManagers {
		if pm == value {
			return true
		}
	}
	return false
}

func linef(opts options, out io.Writer, format string, args ...any) {
	if opts.silent {
		return
	}
	fmt.Fprintf(out, format+"\n", args...)
}

func findUpFile(startDir, name string) (string, bool) {
	dir := startDir
	for {
		candidate := filepath.Join(dir, name)
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func parsePnpmWorkspace(content string) []string {
	scanner := bufio.NewScanner(strings.NewReader(content))
	inPackages := false
	globs := make([]string, 0, 8)
	for scanner.Scan() {
		line := scanner.Text()
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if !inPackages {
			if strings.HasPrefix(trimmed, "packages:") {
				inPackages = true
			}
			continue
		}
		if !strings.HasPrefix(trimmed, "-") {
			if !strings.HasPrefix(line, " ") && !strings.HasPrefix(line, "\t") {
				break
			}
			continue
		}
		v := strings.TrimSpace(strings.TrimPrefix(trimmed, "-"))
		v = strings.Trim(v, "\"'")
		if v != "" {
			globs = append(globs, toPosix(strings.TrimSuffix(v, "/")))
		}
	}
	return globs
}

func detectPNPM(start string) (*detected, error) {
	wsPath, ok := findUpFile(start, "pnpm-workspace.yaml")
	if !ok {
		return nil, nil
	}
	content, err := os.ReadFile(wsPath)
	if err != nil {
		return nil, err
	}
	globs := parsePnpmWorkspace(string(content))
	if len(globs) == 0 {
		return nil, nil
	}
	return &detected{pm: "pnpm", root: filepath.Dir(wsPath), globs: globs}, nil
}

func detectDeno(start string) (*detected, error) {
	denoPath, ok := findUpFile(start, "deno.json")
	if !ok {
		denoPath, ok = findUpFile(start, "deno.jsonc")
		if !ok {
			return nil, nil
		}
	}
	content, err := os.ReadFile(denoPath)
	if err != nil {
		return nil, err
	}
	var config struct {
		Workspace []string `json:"workspace"`
	}
	if err := json.Unmarshal([]byte(parseJSONC(string(content))), &config); err != nil {
		return nil, nil
	}
	if len(config.Workspace) == 0 {
		return nil, nil
	}
	for i := range config.Workspace {
		config.Workspace[i] = toPosix(strings.TrimSuffix(config.Workspace[i], "/"))
	}
	return &detected{pm: "deno", root: filepath.Dir(denoPath), globs: config.Workspace}, nil
}

func detectPkgJSON(start string) (*detected, error) {
	dir := start
	var pkgPath string
	for {
		candidate := filepath.Join(dir, "package.json")
		content, err := os.ReadFile(candidate)
		if err == nil {
			var raw map[string]any
			if json.Unmarshal(content, &raw) == nil {
				if _, ok := raw["workspaces"]; ok {
					pkgPath = candidate
					break
				}
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return nil, nil
		}
		dir = parent
	}
	content, err := os.ReadFile(pkgPath)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Workspaces any `json:"workspaces"`
	}
	if err := json.Unmarshal(content, &raw); err != nil {
		return nil, nil
	}
	globs := make([]string, 0)
	switch v := raw.Workspaces.(type) {
	case []any:
		for _, item := range v {
			s, ok := item.(string)
			if ok && s != "" {
				globs = append(globs, toPosix(strings.TrimSuffix(s, "/")))
			}
		}
	case map[string]any:
		if pkgs, ok := v["packages"].([]any); ok {
			for _, item := range pkgs {
				s, ok := item.(string)
				if ok && s != "" {
					globs = append(globs, toPosix(strings.TrimSuffix(s, "/")))
				}
			}
		}
	}
	if len(globs) == 0 {
		return nil, nil
	}
	root := filepath.Dir(pkgPath)
	pm := "npm"
	if fileExists(filepath.Join(root, "bun.lock")) || fileExists(filepath.Join(root, "bun.lockb")) {
		pm = "bun"
	} else if fileExists(filepath.Join(root, "deno.lock")) {
		pm = "deno"
	} else if fileExists(filepath.Join(root, "yarn.lock")) {
		pm = "yarn"
	}
	return &detected{pm: pm, root: root, globs: globs}, nil
}

func autoDetect(start string) (*detected, error) {
	if d, err := detectPNPM(start); err != nil || d != nil {
		return d, err
	}
	if d, err := detectDeno(start); err != nil || d != nil {
		return d, err
	}
	return detectPkgJSON(start)
}

func detectSpecified(start, pm string) (*detected, error) {
	switch pm {
	case "pnpm":
		return detectPNPM(start)
	case "deno":
		return detectDeno(start)
	default:
		d, err := detectPkgJSON(start)
		if err != nil || d == nil {
			return d, err
		}
		if d.pm == pm {
			return d, nil
		}
		return nil, nil
	}
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func parseArgs(args []string) (options, int, error) {
	opts := options{unified: true}
	for _, arg := range args {
		switch {
		case arg == "--generate" || arg == "-g":
			if opts.mode == "compare" {
				return opts, 2, errors.New("cannot specify both --generate and --compare")
			}
			opts.mode = "generate"
		case arg == "--compare" || arg == "-c":
			if opts.mode == "generate" {
				return opts, 2, errors.New("cannot specify both --generate and --compare")
			}
			opts.mode = "compare"
		case strings.HasPrefix(arg, "--target=") || strings.HasPrefix(arg, "-t="):
			parts := strings.SplitN(arg, "=", 2)
			if len(parts) == 2 {
				targets := strings.Split(parts[1], ",")
				opts.targets = opts.targets[:0]
				for _, t := range targets {
					t = strings.TrimSpace(strings.TrimSuffix(toPosix(t), "/"))
					if t != "" {
						opts.targets = append(opts.targets, t)
					}
				}
			}
		case arg == "--silent" || arg == "-s":
			opts.silent = true
		case arg == "--debug" || arg == "-d":
			opts.debug = true
		case arg == "--workspaces" || arg == "-w":
			opts.unified = false
		case strings.HasPrefix(arg, "--packagemanager=") || strings.HasPrefix(arg, "-pm="):
			parts := strings.SplitN(arg, "=", 2)
			if len(parts) != 2 || !isPackageManager(parts[1]) {
				return opts, 2, fmt.Errorf("invalid package manager (%q), supported values are: %s", parts[1], strings.Join(packageManagers, ", "))
			}
			opts.pmOption = parts[1]
		case arg == "--help" || arg == "-h":
			return opts, 0, nil
		default:
			return opts, 3, fmt.Errorf("unknown option: %s", arg)
		}
	}
	if opts.mode == "" {
		return opts, 2, errors.New("must specify either --generate (-g) or --compare (-c)")
	}
	return opts, -1, nil
}

func printHelp(out io.Writer) {
	_, _ = io.WriteString(out, `
monorepo-hash by EDM115
A simple script to generate or compare .hash files for monorepo workspaces
Supports PNPM, Yarn, NPM, Bun and Deno

Arguments :
  --generate        (-g)   Generate or update .hash files for all workspaces
  --compare         (-c)   Compare current state with existing .hash files. Capture the exit code to check for changes
  --target="<path>" (-t)   Specify one or more targets to generate/compare (comma-separated)
  --silent          (-s)   Suppress output messages
  --debug           (-d)   Enable debug mode (per-file hashes)
  --workspaces      (-w)   Use per-workspace .hash files instead of a single root one
  --packagemanager  (-pm)  Force the package manager (pnpm, npm, deno, bun, yarn)
  --help            (-h)   Show this help message
`)
}

func collectWorkspacePackageJSONs(root string, globs []string) ([]string, error) {
	compiled := make([]*regexp.Regexp, 0, len(globs))
	for _, g := range globs {
		g = toPosix(strings.TrimSuffix(strings.TrimPrefix(g, "./"), "/"))
		re, err := compileGlob(g, true)
		if err != nil {
			return nil, err
		}
		compiled = append(compiled, re)
	}
	paths := make([]string, 0, 64)
	err := filepath.WalkDir(root, func(current string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			name := d.Name()
			if name == "node_modules" || name == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() != "package.json" {
			return nil
		}
		rel, err := filepath.Rel(root, filepath.Dir(current))
		if err != nil {
			return err
		}
		rel = toPosix(rel)
		for _, re := range compiled {
			if re.MatchString(rel) {
				paths = append(paths, current)
				return nil
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	return paths, nil
}

func getWorkspaceFileList(pkgDir, relDir string, rootIgnore, pkgIgnore *ignoreMatcher) ([]string, error) {
	files := make([]string, 0, 64)
	err := filepath.WalkDir(pkgDir, func(current string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		relNative, err := filepath.Rel(pkgDir, current)
		if err != nil {
			return err
		}
		rel := toPosix(relNative)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" || d.Name() == ".git" {
				return filepath.SkipDir
			}
			repoPath := rel
			if relDir != "" {
				repoPath = relDir + "/" + rel
			}
			if rootIgnore.shouldIgnore(repoPath, true) || pkgIgnore.shouldIgnore(rel, true) {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Name() == ".hash" || d.Name() == ".debug-hash" {
			return nil
		}
		repoPath := rel
		if relDir != "" {
			repoPath = relDir + "/" + rel
		}
		if rootIgnore.shouldIgnore(repoPath, false) || pkgIgnore.shouldIgnore(rel, false) {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

func computePerFileHashes(dir string, fileList []string) (map[string]string, error) {
	if len(fileList) == 0 {
		return map[string]string{}, nil
	}
	workers := runtime.NumCPU()
	if workers < 2 {
		workers = 2
	}
	type result struct {
		path string
		hash string
		err  error
	}
	jobs := make(chan string)
	results := make(chan result, len(fileList))
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for rel := range jobs {
				full := filepath.Join(dir, filepath.FromSlash(rel))
				content, err := os.ReadFile(full)
				if err != nil {
					results <- result{err: err}
					continue
				}
				h := sha256.New()
				h.Write([]byte(rel))
				h.Write(content)
				results <- result{path: rel, hash: hex.EncodeToString(h.Sum(nil))}
			}
		}()
	}
	for _, rel := range fileList {
		jobs <- rel
	}
	close(jobs)
	wg.Wait()
	close(results)
	output := make(map[string]string, len(fileList))
	for r := range results {
		if r.err != nil {
			return nil, r.err
		}
		output[r.path] = r.hash
	}
	return output, nil
}

func computeOwnHashFromPerFile(perFile map[string]string) ([]byte, error) {
	keys := make([]string, 0, len(perFile))
	for k := range perFile {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	h := sha256.New()
	buf := make([]byte, 32)
	for _, k := range keys {
		decoded, err := hex.DecodeString(perFile[k])
		if err != nil {
			return nil, err
		}
		copy(buf, decoded)
		h.Write(buf)
	}
	return h.Sum(nil), nil
}

func computeFinalHash(pkgName string, pkgs map[string]pkgInfo, cache map[string]string, visiting map[string]bool) (string, error) {
	if h, ok := cache[pkgName]; ok {
		return h, nil
	}
	if visiting[pkgName] {
		return "", fmt.Errorf("circular dependency detected: %s", pkgName)
	}
	pkg, ok := pkgs[pkgName]
	if !ok {
		return "", fmt.Errorf("package metadata missing for %s", pkgName)
	}
	if len(pkg.ownHash) == 0 {
		return "", fmt.Errorf("ownHash missing for package %s", pkgName)
	}
	visiting[pkgName] = true
	h := sha256.New()
	h.Write(pkg.ownHash)
	for _, dep := range pkg.deps {
		depHex, err := computeFinalHash(dep, pkgs, cache, visiting)
		if err != nil {
			return "", err
		}
		buf, err := hex.DecodeString(depHex)
		if err != nil {
			return "", err
		}
		h.Write(buf)
	}
	delete(visiting, pkgName)
	final := hex.EncodeToString(h.Sum(nil))
	cache[pkgName] = final
	return final, nil
}

func loadRootHashFile(root string) (map[string]string, error) {
	p := filepath.Join(root, ".hash")
	content, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var parsed map[string]string
	if err := json.Unmarshal(content, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func writeRootHashFile(root string, update map[string]string) error {
	normalized := map[string]string{}
	existing, err := loadRootHashFile(root)
	if err != nil {
		return err
	}
	for k, v := range existing {
		normalized[toPosix(k)] = v
	}
	for k, v := range update {
		normalized[toPosix(k)] = v
	}
	keys := make([]string, 0, len(normalized))
	for k := range normalized {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make(map[string]string, len(keys))
	for _, k := range keys {
		ordered[k] = normalized[k]
	}
	content, err := json.MarshalIndent(ordered, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, ".hash"), content, 0o644)
}

func writeDebugFile(dir string, m map[string]string) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make(map[string]string, len(keys))
	for _, k := range keys {
		ordered[k] = m[k]
	}
	content, err := json.MarshalIndent(ordered, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".debug-hash"), content, 0o644)
}

func writeRootDebugFile(root string, m map[string]map[string]string) error {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make(map[string]map[string]string, len(keys))
	for _, k := range keys {
		ordered[k] = m[k]
	}
	content, err := json.MarshalIndent(ordered, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, ".debug-hash"), content, 0o644)
}

func generateHashes(opts options, out io.Writer, repoRoot string, pkgs map[string]pkgInfo, finalCache map[string]string) error {
	names := make([]string, 0, len(pkgs))
	for name := range pkgs {
		names = append(names, name)
	}
	sort.Strings(names)
	targetSet := map[string]struct{}{}
	if len(opts.targets) > 0 {
		for _, t := range opts.targets {
			targetSet[t] = struct{}{}
		}
	}
	if opts.unified {
		m := make(map[string]string)
		for _, name := range names {
			rel := toPosix(pkgs[name].relDir)
			if len(targetSet) > 0 {
				if _, ok := targetSet[rel]; !ok {
					continue
				}
			}
			m[rel] = finalCache[name]
		}
		if err := writeRootHashFile(repoRoot, m); err != nil {
			return err
		}
		rels := make([]string, 0, len(m))
		for rel := range m {
			rels = append(rels, rel)
		}
		sort.Strings(rels)
		for _, rel := range rels {
			linef(opts, out, "✅ %s (%s written to .hash)", rel, m[rel])
		}
		return nil
	}
	for _, name := range names {
		p := pkgs[name]
		rel := toPosix(p.relDir)
		if len(targetSet) > 0 {
			if _, ok := targetSet[rel]; !ok {
				continue
			}
		}
		hash := finalCache[name]
		if err := os.WriteFile(filepath.Join(p.dir, ".hash"), []byte(hash), 0o644); err != nil {
			return err
		}
		linef(opts, out, "✅ %s (%s written to .hash)", rel, hash)
	}
	return nil
}

func compareHashes(opts options, out io.Writer, repoRoot string, pkgs map[string]pkgInfo, finalCache map[string]string) (compareResult, error) {
	res := compareResult{}
	oldHashMap := map[string]string{}
	if opts.unified {
		rootHashes, err := loadRootHashFile(repoRoot)
		if err != nil {
			return res, err
		}
		for pkgName, info := range pkgs {
			if old, ok := rootHashes[toPosix(info.relDir)]; ok {
				oldHashMap[pkgName] = old
			}
		}
	} else {
		for pkgName, info := range pkgs {
			content, err := os.ReadFile(filepath.Join(info.dir, ".hash"))
			if err == nil {
				oldHashMap[pkgName] = strings.TrimSpace(string(content))
			}
		}
	}

	allChanged := map[string]struct{}{}
	for name, current := range finalCache {
		if old, ok := oldHashMap[name]; ok && old != current {
			allChanged[name] = struct{}{}
		}
	}

	adjacency := map[string][]string{}
	for name, info := range pkgs {
		adjacency[name] = append([]string{}, info.deps...)
	}
	transitiveCache := map[string]map[string]struct{}{}
	getTransitive := func(pkgName string) map[string]struct{} {
		if c, ok := transitiveCache[pkgName]; ok {
			return c
		}
		visited := map[string]struct{}{}
		stack := append([]string{}, adjacency[pkgName]...)
		for len(stack) > 0 {
			dep := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if _, ok := visited[dep]; ok {
				continue
			}
			visited[dep] = struct{}{}
			for _, next := range adjacency[dep] {
				if _, ok := visited[next]; !ok {
					stack = append(stack, next)
				}
			}
		}
		transitiveCache[pkgName] = visited
		return visited
	}

	toCheck := make([]string, 0, len(pkgs))
	if len(opts.targets) > 0 {
		targetSet := map[string]struct{}{}
		for _, t := range opts.targets {
			targetSet[t] = struct{}{}
		}
		for pkgName, info := range pkgs {
			if _, ok := targetSet[toPosix(info.relDir)]; ok {
				toCheck = append(toCheck, pkgName)
			}
		}
	} else {
		for pkgName := range pkgs {
			toCheck = append(toCheck, pkgName)
		}
	}
	sort.Strings(toCheck)

	for _, pkgName := range toCheck {
		info := pkgs[pkgName]
		newHash := finalCache[pkgName]
		oldHash, hasOld := oldHashMap[pkgName]
		posixRel := toPosix(info.relDir)
		if !hasOld {
			res.MissingTargets = append(res.MissingTargets, compareMissing{Name: posixRel, NewHash: newHash})
			continue
		}
		depsChanged := make([]string, 0)
		for dep := range getTransitive(pkgName) {
			if _, ok := allChanged[dep]; ok {
				depsChanged = append(depsChanged, toPosix(pkgs[dep].relDir))
			}
		}
		sort.Strings(depsChanged)
		if oldHash != newHash || len(depsChanged) > 0 {
			res.ChangedTargets = append(res.ChangedTargets, compareChanged{Name: posixRel, OldHash: oldHash, NewHash: newHash, ChangedDep: depsChanged})
		} else {
			res.UnchangedTargets = append(res.UnchangedTargets, posixRel)
		}
	}

	sort.Strings(res.UnchangedTargets)
	sort.Slice(res.ChangedTargets, func(i, j int) bool { return res.ChangedTargets[i].Name < res.ChangedTargets[j].Name })
	sort.Slice(res.MissingTargets, func(i, j int) bool { return res.MissingTargets[i].Name < res.MissingTargets[j].Name })

	if len(res.UnchangedTargets) > 0 {
		linef(opts, out, "✅ Unchanged (%d) :", len(res.UnchangedTargets))
		for _, name := range res.UnchangedTargets {
			linef(opts, out, "• %s", name)
		}
		linef(opts, out, "")
	}
	if len(res.ChangedTargets) > 0 {
		linef(opts, out, "⚠️  Changed (%d) :", len(res.ChangedTargets))
		for _, c := range res.ChangedTargets {
			linef(opts, out, "• %s", c.Name)
			linef(opts, out, "\told : %s", c.OldHash)
			linef(opts, out, "\tnew : %s", c.NewHash)
			if len(c.ChangedDep) > 0 {
				linef(opts, out, "\t🚧 changed dependency(s) :")
				for _, d := range c.ChangedDep {
					linef(opts, out, "\t\t• %s", d)
				}
			}
		}
		linef(opts, out, "")
	}
	if len(res.MissingTargets) > 0 {
		linef(opts, out, "❓ Missing .hash files (%d) :", len(res.MissingTargets))
		for _, m := range res.MissingTargets {
			linef(opts, out, "• %s (would be %s)", m.Name, m.NewHash)
		}
		linef(opts, out, "")
	}

	return res, nil
}

func execute(args []string, stdout, stderr io.Writer) int {
	opts, code, err := parseArgs(args)
	if code == 0 && err == nil && opts.mode == "" {
		printHelp(stdout)
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "❌ %s\n", err.Error())
		return code
	}

	if opts.mode == "generate" {
		if len(opts.targets) > 0 {
			linef(opts, stdout, "ℹ️  Generating hashes for specified targets... (%s)", strings.Join(opts.targets, ","))
		} else {
			linef(opts, stdout, "ℹ️  Generating hashes for all workspaces...\n")
		}
	} else {
		if len(opts.targets) > 0 {
			linef(opts, stdout, "ℹ️  Comparing hashes for specified targets... (%s)", strings.Join(opts.targets, ","))
		} else {
			linef(opts, stdout, "ℹ️  Comparing hashes for all workspaces...\n")
		}
	}
	if opts.debug {
		linef(opts, stdout, "ℹ️  Debug mode enabled\n")
	}
	if !opts.unified {
		linef(opts, stdout, "ℹ️  Per-workspace mode enabled\n")
	}

	wd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(stderr, "❌ %s\n", err.Error())
		return 99
	}
	var d *detected
	if opts.pmOption != "" {
		d, err = detectSpecified(wd, opts.pmOption)
	} else {
		d, err = autoDetect(wd)
	}
	if err != nil {
		fmt.Fprintf(stderr, "❌ %s\n", err.Error())
		return 99
	}
	if d == nil {
		if opts.pmOption != "" {
			auto, _ := autoDetect(wd)
			if auto != nil {
				fmt.Fprintf(stderr, "❌ %s workspaces not found. Did you mean --packagemanager=%s?\n", opts.pmOption, auto.pm)
			} else {
				fmt.Fprintln(stderr, "❌ Specified package manager not found and no supported package manager detected")
			}
			return 5
		}
		fmt.Fprintln(stderr, "❌ No workspaces found or unsupported package manager")
		return 4
	}

	repoRoot, _ := filepath.Abs(d.root)
	linef(opts, stdout, "ℹ️  Using %s workspaces from %s\n", d.pm, repoRoot)

	rootIgnore := &ignoreMatcher{}
	rootGitignorePath := filepath.Join(repoRoot, ".gitignore")
	if content, err := os.ReadFile(rootGitignorePath); err == nil {
		rootIgnore = parseIgnore(string(content))
	}
	rootIgnore.rules = append(rootIgnore.rules,
		rule{pattern: "**/.hash", hasSlash: true, re: mustGlob("**/.hash")},
		rule{pattern: "**/.debug-hash", hasSlash: true, re: mustGlob("**/.debug-hash")},
	)

	pkgJSONPaths, err := collectWorkspacePackageJSONs(repoRoot, d.globs)
	if err != nil {
		fmt.Fprintf(stderr, "❌ %s\n", err.Error())
		return 99
	}
	if len(pkgJSONPaths) == 0 {
		fmt.Fprintln(stderr, "❌ No package.json files found in workspaces")
		return 4
	}

	meta := make(map[string]pkgMeta, len(pkgJSONPaths))
	relToName := make(map[string]string, len(pkgJSONPaths))
	manifests := make(map[string]packageManifest, len(pkgJSONPaths))
	for _, pkgPath := range pkgJSONPaths {
		content, err := os.ReadFile(pkgPath)
		if err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
		var manifest packageManifest
		if err := json.Unmarshal(content, &manifest); err != nil {
			fmt.Fprintf(stderr, "❌ Invalid JSON in %s\n", pkgPath)
			return 99
		}
		if manifest.Name == "" {
			fmt.Fprintf(stderr, "❌ Missing package name in %s\n", pkgPath)
			return 99
		}
		dir := filepath.Dir(pkgPath)
		relDirNative, _ := filepath.Rel(repoRoot, dir)
		relDir := toPosix(relDirNative)
		meta[manifest.Name] = pkgMeta{name: manifest.Name, dir: dir, relDir: relDir}
		relToName[relDir] = manifest.Name
		manifests[manifest.Name] = manifest
	}

	for name, m := range meta {
		manifest := manifests[name]
		depSet := map[string]struct{}{}
		addDeps := func(deps map[string]string) {
			for dep := range deps {
				if _, ok := meta[dep]; ok {
					depSet[dep] = struct{}{}
				}
			}
		}
		addDeps(manifest.Dependencies)
		addDeps(manifest.DevDependencies)
		addDeps(manifest.PeerDependencies)
		deps := make([]string, 0, len(depSet))
		for dep := range depSet {
			deps = append(deps, dep)
		}
		sort.Strings(deps)
		m.deps = deps
		meta[name] = m
	}

	namesToProcess := map[string]struct{}{}
	var addWithDeps func(string)
	addWithDeps = func(pkgName string) {
		if _, ok := namesToProcess[pkgName]; ok {
			return
		}
		namesToProcess[pkgName] = struct{}{}
		for _, dep := range meta[pkgName].deps {
			addWithDeps(dep)
		}
	}
	if len(opts.targets) > 0 {
		for _, t := range opts.targets {
			if name, ok := relToName[t]; ok {
				addWithDeps(name)
			}
		}
	} else {
		for name := range meta {
			namesToProcess[name] = struct{}{}
		}
	}

	toHash := make([]string, 0, len(namesToProcess))
	for n := range namesToProcess {
		toHash = append(toHash, n)
	}
	sort.Strings(toHash)

	total := len(toHash)
	linef(opts, stdout, "🔄 Computing hashes (0/%d)", total)

	pkgs := make(map[string]pkgInfo, len(toHash))
	debugRootOutput := map[string]map[string]string{}
	for idx, name := range toHash {
		m := meta[name]
		pkgIgnore := &ignoreMatcher{}
		if content, err := os.ReadFile(filepath.Join(m.dir, ".gitignore")); err == nil {
			pkgIgnore = parseIgnore(string(content))
		}
		files, err := getWorkspaceFileList(m.dir, m.relDir, rootIgnore, pkgIgnore)
		if err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
		perFile, err := computePerFileHashes(m.dir, files)
		if err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
		ownHash, err := computeOwnHashFromPerFile(perFile)
		if err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
		pkgs[name] = pkgInfo{dir: m.dir, relDir: m.relDir, deps: m.deps, perFileHashes: perFile, ownHash: ownHash}
		linef(opts, stdout, "🔄 Computing hashes (%d/%d) • %s", idx+1, total, m.relDir)
		if opts.debug && opts.mode == "generate" {
			if opts.unified {
				debugRootOutput[m.relDir] = perFile
			} else if err := writeDebugFile(m.dir, perFile); err != nil {
				fmt.Fprintf(stderr, "❌ %s\n", err.Error())
				return 99
			}
		}
	}
	if opts.mode == "generate" && opts.debug && opts.unified {
		if err := writeRootDebugFile(repoRoot, debugRootOutput); err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
	}
	linef(opts, stdout, "✅ Computed all hashes (%d)\n", total)

	finalCache := make(map[string]string, len(pkgs))
	for _, name := range toHash {
		if _, err := computeFinalHash(name, pkgs, finalCache, map[string]bool{}); err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 6
		}
	}

	if opts.mode == "generate" {
		if err := generateHashes(opts, stdout, repoRoot, pkgs, finalCache); err != nil {
			fmt.Fprintf(stderr, "❌ %s\n", err.Error())
			return 99
		}
		return 0
	}
	compareRes, err := compareHashes(opts, stdout, repoRoot, pkgs, finalCache)
	if err != nil {
		fmt.Fprintf(stderr, "❌ %s\n", err.Error())
		return 99
	}
	if len(compareRes.ChangedTargets) > 0 || len(compareRes.MissingTargets) > 0 {
		return 1
	}
	return 0
}

func mustGlob(g string) *regexp.Regexp {
	re, _ := compileGlob(g, false)
	return re
}

func main() {
	os.Exit(execute(os.Args[1:], os.Stdout, os.Stderr))
}
