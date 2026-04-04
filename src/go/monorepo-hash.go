//lint:file-ignore ST1005 Needed for parity

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	json "encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/bmatcuk/doublestar/v4"
	gitignore "github.com/go-git/go-git/v6/plumbing/format/gitignore"
	yaml "go.yaml.in/yaml/v4"
)

var packageManagers = []string{"pnpm", "npm", "deno", "bun", "yarn"}

const CLI_VERSION = "2.2.0"

var usePathCache = true
var needsPathConversion = filepath.Separator != '/'
var displayPathCache sync.Map

type options struct {
	mode      string
	targets   []string
	silent    bool
	help      bool
	debug     bool
	unified   bool
	pmOption  string
	version   bool
	pathCache bool
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

type ignoreMatcher struct {
	m gitignore.Matcher
}

func (m *ignoreMatcher) shouldIgnore(rel string, isDir bool) bool {
	if m == nil || m.m == nil {
		return false
	}
	rel = toPosix(rel)
	if rel == "" || rel == "." {
		return false
	}
	parts := strings.Split(rel, "/")
	return m.m.Match(parts, isDir)
}

func newIgnoreMatcher(content string, domain []string) *ignoreMatcher {
	patterns := make([]gitignore.Pattern, 0, 32)
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		patterns = append(patterns, gitignore.ParsePattern(line, domain))
	}
	return &ignoreMatcher{m: gitignore.NewMatcher(patterns)}
}

func toPosix(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

func findFirstSupportedExtglob(pattern string) (int, byte) {
	for i := 0; i+1 < len(pattern); i++ {
		if (pattern[i] == '@' || pattern[i] == '?') && pattern[i+1] == '(' {
			return i, pattern[i]
		}
	}

	return -1, 0
}

func findMatchingParen(pattern string, open int) int {
	depth := 0

	for i := open; i < len(pattern); i++ {
		switch pattern[i] {
		case '(':
			depth++
		case ')':
			depth--
			if depth == 0 {
				return i
			}
		}
	}

	return -1
}

func splitExtglobAlternatives(body string) []string {
	if body == "" {
		return []string{""}
	}

	parts := make([]string, 0, 4)
	start := 0
	depth := 0

	for i := 0; i < len(body); i++ {
		switch body[i] {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		case '|':
			if depth == 0 {
				parts = append(parts, body[start:i])
				start = i + 1
			}
		}
	}

	parts = append(parts, body[start:])

	return parts
}

func expandSupportedExtglob(pattern string) []string {
	idx, op := findFirstSupportedExtglob(pattern)
	if idx < 0 {
		return []string{pattern}
	}

	open := idx + 1
	close := findMatchingParen(pattern, open)
	if close < 0 {
		return []string{pattern}
	}

	alts := splitExtglobAlternatives(pattern[open+1 : close])
	replacements := make([]string, 0, len(alts)+1)
	switch op {
	case '@':
		replacements = append(replacements, alts...)
	case '?':
		replacements = append(replacements, "")
		replacements = append(replacements, alts...)
	default:
		return []string{pattern}
	}

	prefix := pattern[:idx]
	suffix := pattern[close+1:]
	expanded := make([]string, 0, len(replacements))

	for _, rep := range replacements {
		next := prefix + rep + suffix
		expanded = append(expanded, expandSupportedExtglob(next)...)
	}

	return expanded
}

func displayPath(p string, forceDisableCache bool) string {
	if !needsPathConversion {
		return p
	}
	transformed := strings.ReplaceAll(p, "\\", "/")
	if !usePathCache || forceDisableCache {
		return transformed
	}
	if cached, ok := displayPathCache.Load(p); ok {
		if s, ok := cached.(string); ok {
			return s
		}
	}
	displayPathCache.Store(p, transformed)
	return transformed
}

func isPackageManager(value string) bool {
	return slices.Contains(packageManagers, value)
}

func linef(opts options, out io.Writer, format string, args ...any) {
	if opts.silent {
		return
	}
	fmt.Fprintf(out, format+"\n", args...)
}

func canOverwriteLine(out io.Writer) bool {
	f, ok := out.(*os.File)
	if !ok {
		return false
	}
	st, err := f.Stat()
	if err != nil {
		return false
	}
	if st.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	term := strings.ToLower(strings.TrimSpace(os.Getenv("TERM")))
	return term != "dumb"
}

func logf(opts options, out io.Writer, overwrite bool, format string, args ...any) {
	if opts.silent {
		return
	}
	msg := fmt.Sprintf(format, args...)
	if overwrite && canOverwriteLine(out) {
		fmt.Fprintf(out, "\r\x1b[2K%s", msg)
		return
	}
	if overwrite {
		fmt.Fprintln(out, "\r"+msg)
		return
	}
	fmt.Fprintln(out, msg)
}

func zeroPad(num, places int) string {
	return fmt.Sprintf("%0*d", places, num)
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

func detectPNPM(start string) (*detected, error) {
	wsPath, ok := findUpFile(start, "pnpm-workspace.yaml")
	if !ok {
		return nil, nil
	}
	content, err := os.ReadFile(wsPath)
	if err != nil {
		return nil, err
	}
	var config struct {
		Packages []string `yaml:"packages"`
	}
	if err := yaml.Load(content, &config); err != nil {
		return nil, err
	}
	globs := make([]string, 0, len(config.Packages))
	for _, g := range config.Packages {
		if g == "" {
			continue
		}
		if after, ok := strings.CutPrefix(g, "!"); ok {
			n := toPosix(strings.TrimSuffix(after, "/"))
			if n != "" {
				globs = append(globs, "!"+n)
			}
		} else {
			globs = append(globs, toPosix(strings.TrimSuffix(g, "/")))
		}
	}
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
	if err := json.Unmarshal(content, &config); err != nil {
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
	opts := options{unified: true, pathCache: true}
	for _, arg := range args {
		switch {
		case arg == "--generate" || arg == "-g":
			if opts.mode == "compare" {
				return opts, 2, errors.New("Cannot specify both --generate and --compare")
			}
			opts.mode = "generate"
		case arg == "--compare" || arg == "-c":
			if opts.mode == "generate" {
				return opts, 2, errors.New("Cannot specify both --generate and --compare")
			}
			opts.mode = "compare"
		case strings.HasPrefix(arg, "--target=") || strings.HasPrefix(arg, "-t="):
			parts := strings.SplitN(arg, "=", 2)
			if len(parts) == 2 {
				targets := strings.Split(parts[1], ",")
				opts.targets = make([]string, len(targets))
				for i, t := range targets {
					opts.targets[i] = strings.TrimRight(toPosix(t), "/")
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
				return opts, 2, fmt.Errorf("Invalid package manager (%q), supported values are : %s", parts[1], strings.Join(packageManagers, ", "))
			}
			opts.pmOption = parts[1]
		case arg == "--help" || arg == "-h":
			opts.help = true
		case arg == "--version" || arg == "-v":
			opts.version = true
		case arg == "--nopathcache" || arg == "-npc":
			opts.pathCache = false
		default:
			return opts, 3, fmt.Errorf("Unknown option : %s", arg)
		}
	}
	if opts.mode == "" || opts.help {
		return opts, 0, nil
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
  --nopathcache     (-npc) Disable path normalization cache (can reduce memory footprint on very large repos)
  --version         (-v)   Show version information
  --help            (-h)   Show this help message

`)
}

func loadDebugFile(dir string) (map[string]string, error) {
	p := filepath.Join(dir, ".debug-hash")
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

func loadRootDebugFile(root string) (map[string]map[string]string, error) {
	p := filepath.Join(root, ".debug-hash")
	content, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var parsed map[string]map[string]string
	if err := json.Unmarshal(content, &parsed); err != nil {
		return nil, err
	}
	return parsed, nil
}

func generateDebug(opts options, out io.Writer, info pkgInfo, oldDebug map[string]string) ([]string, error) {
	if oldDebug == nil {
		linef(opts, out, "❓ <debug> %s has no .debug-hash to compare", displayPath(info.relDir, false))
		linef(opts, out, "")
		return []string{}, nil
	}
	diverged := make([]string, 0)
	seen := make(map[string]struct{}, len(oldDebug)+len(info.perFileHashes))
	for k := range oldDebug {
		seen[k] = struct{}{}
	}
	for k := range info.perFileHashes {
		seen[k] = struct{}{}
	}
	keys := make([]string, 0, len(seen))
	for k := range seen {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if oldDebug[k] != info.perFileHashes[k] {
			diverged = append(diverged, k)
		}
	}
	if len(diverged) > 0 {
		linef(opts, out, "⚠️  <debug> %s diverging files :", displayPath(info.relDir, false))
		for _, f := range diverged {
			linef(opts, out, "  • %s", displayPath(f, false))
		}
		linef(opts, out, "")
	}
	return diverged, nil
}

func collectWorkspacePackageJSONs(root string, globs []string) ([]string, error) {
	matches := make([]string, 0, 64)
	seen := map[string]struct{}{}

	for _, g := range globs {
		negated := strings.HasPrefix(g, "!")
		pattern := strings.TrimPrefix(g, "!")
		pattern = strings.TrimSuffix(strings.TrimPrefix(pattern, "./"), "/")
		if pattern == "" {
			continue
		}

		expandedPatterns := expandSupportedExtglob(pattern)
		for _, expanded := range expandedPatterns {
			fullPattern := filepath.Join(root, filepath.FromSlash(expanded), "package.json")

			found, err := doublestar.FilepathGlob(fullPattern)
			if err != nil {
				return nil, err
			}

			if negated {
				for _, p := range found {
					delete(seen, filepath.Clean(p))
				}
				continue
			}

			for _, p := range found {
				seen[filepath.Clean(p)] = struct{}{}
			}
		}
	}

	for p := range seen {
		matches = append(matches, p)
	}
	sort.Strings(matches)
	return matches, nil
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
			if rootIgnore.shouldIgnore(repoPath, true) || pkgIgnore.shouldIgnore(repoPath, true) {
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
		if rootIgnore.shouldIgnore(repoPath, false) || pkgIgnore.shouldIgnore(repoPath, false) {
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
	workers := min(max(runtime.NumCPU(), 2), len(fileList))
	type result struct {
		path string
		hash string
	}
	results := make([]result, len(fileList))
	var next atomic.Uint32
	var cancelled atomic.Bool
	var wg sync.WaitGroup
	var firstErr error
	var errOnce sync.Once

	setError := func(err error) {
		errOnce.Do(func() {
			firstErr = err
			cancelled.Store(true)
		})
	}

	for range workers {
		wg.Go(func() {
			for !cancelled.Load() {
				current := int(next.Add(1)) - 1
				if current >= len(fileList) {
					return
				}

				rel := fileList[current]
				full := filepath.Join(dir, filepath.FromSlash(rel))
				content, err := os.ReadFile(full)
				if err != nil {
					setError(err)
					return
				}
				h := sha256.New()
				h.Write([]byte(rel))
				h.Write(content)

				if cancelled.Load() {
					return
				}

				results[current] = result{path: rel, hash: hex.EncodeToString(h.Sum(nil))}
			}
		})
	}
	wg.Wait()

	if firstErr != nil {
		return nil, firstErr
	}

	output := make(map[string]string, len(fileList))
	for _, r := range results {
		if r.path == "" {
			continue
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
	for _, k := range keys {
		decoded, err := hex.DecodeString(perFile[k])
		if err != nil {
			return nil, err
		}
		h.Write(decoded)
	}
	return h.Sum(nil), nil
}

func computeFinalHash(pkgName string, pkgs map[string]pkgInfo, cache map[string]string, stack []string, visitingIndex map[string]int) (string, error) {
	if h, ok := cache[pkgName]; ok {
		return h, nil
	}
	if idx, ok := visitingIndex[pkgName]; ok {
		cycle := append(append([]string{}, stack[idx:]...), pkgName)
		return "", fmt.Errorf("Circular dependency detected : %s", strings.Join(cycle, " -> "))
	}
	pkg, ok := pkgs[pkgName]
	if !ok {
		return "", fmt.Errorf("Metadata missing for package %s", pkgName)
	}
	if len(pkg.ownHash) == 0 {
		return "", fmt.Errorf("ownHash missing for package %s", pkgName)
	}
	visitingIndex[pkgName] = len(stack)
	stack = append(stack, pkgName)
	h := sha256.New()
	h.Write(pkg.ownHash)
	for _, dep := range pkg.deps {
		depHex, err := computeFinalHash(dep, pkgs, cache, stack, visitingIndex)
		if err != nil {
			return "", err
		}
		buf, err := hex.DecodeString(depHex)
		if err != nil {
			return "", err
		}
		h.Write(buf)
	}
	delete(visitingIndex, pkgName)
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

func marshalSortedStringMap(m map[string]string) ([]byte, error) {
	if len(m) == 0 {
		return []byte("{}"), nil
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.Grow(len(keys) * 80)
	b.WriteString("{\n")

	for i, k := range keys {
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		valueJSON, err := json.Marshal(m[k])
		if err != nil {
			return nil, err
		}

		b.WriteString("  ")
		b.Write(keyJSON)
		b.WriteString(": ")
		b.Write(valueJSON)
		if i < len(keys)-1 {
			b.WriteString(",\n")
		} else {
			b.WriteString("\n")
		}
	}

	b.WriteString("}")

	return []byte(b.String()), nil
}

func marshalSortedNestedStringMap(m map[string]map[string]string) ([]byte, error) {
	if len(m) == 0 {
		return []byte("{}"), nil
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var b strings.Builder
	b.Grow(len(keys) * 160)
	b.WriteString("{\n")

	for i, k := range keys {
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}

		inner, err := marshalSortedStringMap(m[k])
		if err != nil {
			return nil, err
		}

		innerLines := strings.Split(string(inner), "\n")

		b.WriteString("  ")
		b.Write(keyJSON)
		b.WriteString(": ")

		if len(innerLines) == 1 {
			b.WriteString(innerLines[0])
		} else {
			b.WriteString(innerLines[0])
			b.WriteByte('\n')
			for lineIndex := 1; lineIndex < len(innerLines); lineIndex++ {
				b.WriteString("  ")
				b.WriteString(innerLines[lineIndex])
				if lineIndex < len(innerLines)-1 {
					b.WriteByte('\n')
				}
			}
		}

		if i < len(keys)-1 {
			b.WriteString(",\n")
		} else {
			b.WriteByte('\n')
		}
	}

	b.WriteString("}")

	return []byte(b.String()), nil
}

func writeRootHashFile(root string, update map[string]string) error {
	normalized := map[string]string{}
	existing, err := loadRootHashFile(root)
	if err != nil {
		return err
	}
	for k, v := range existing {
		normalized[displayPath(k, false)] = v
	}
	for k, v := range update {
		normalized[displayPath(k, false)] = v
	}
	content, err := marshalSortedStringMap(normalized)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, ".hash"), content, 0o644)
}

func writeDebugFile(dir string, m map[string]string) error {
	normalized := make(map[string]string, len(m))
	for k, v := range m {
		normalized[displayPath(k, false)] = v
	}

	content, err := marshalSortedStringMap(normalized)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, ".debug-hash"), content, 0o644)
}

func writeRootDebugFile(root string, m map[string]map[string]string) error {
	normalized := make(map[string]map[string]string, len(m))
	for k, perFile := range m {
		normPerFile := make(map[string]string, len(perFile))
		for fk, fv := range perFile {
			normPerFile[displayPath(fk, false)] = fv
		}
		normalized[displayPath(k, false)] = normPerFile
	}

	content, err := marshalSortedNestedStringMap(normalized)
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
			rel := displayPath(pkgs[name].relDir, false)
			if len(targetSet) > 0 {
				if _, ok := targetSet[rel]; !ok {
					continue
				}
			}
			hash, ok := finalCache[name]
			if !ok {
				return fmt.Errorf("final hash missing for package %s", name)
			}
			m[rel] = hash
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
		rel := displayPath(p.relDir, false)
		if len(targetSet) > 0 {
			if _, ok := targetSet[rel]; !ok {
				continue
			}
		}
		hash, ok := finalCache[name]
		if !ok {
			return fmt.Errorf("final hash missing for package %s", name)
		}
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
	var rootDebug map[string]map[string]string
	if opts.unified {
		rootHashes, err := loadRootHashFile(repoRoot)
		if err != nil {
			return res, err
		}
		if opts.debug {
			rootDebug, err = loadRootDebugFile(repoRoot)
			if err != nil {
				return res, err
			}
		}
		for pkgName, info := range pkgs {
			if old, ok := rootHashes[displayPath(info.relDir, false)]; ok && old != "" {
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
		newHash, ok := finalCache[pkgName]
		if !ok {
			return res, fmt.Errorf("final hash missing for package %s", pkgName)
		}
		oldHash, hasOld := oldHashMap[pkgName]
		posixRel := displayPath(info.relDir, false)
		if !hasOld {
			res.MissingTargets = append(res.MissingTargets, compareMissing{Name: posixRel, NewHash: newHash})
			continue
		}
		if opts.debug {
			if opts.unified {
				if rootDebug != nil {
					_, err := generateDebug(opts, out, info, rootDebug[posixRel])
					if err != nil {
						return res, err
					}
				}
			} else {
				oldDebug, err := loadDebugFile(info.dir)
				if err != nil {
					return res, err
				}
				_, err = generateDebug(opts, out, info, oldDebug)
				if err != nil {
					return res, err
				}
			}
		}
		depsChanged := make([]string, 0)
		for dep := range getTransitive(pkgName) {
			if _, ok := allChanged[dep]; ok {
				if depInfo, ok := pkgs[dep]; ok {
					depsChanged = append(depsChanged, displayPath(depInfo.relDir, false))
				}
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
	usePathCache = opts.pathCache
	displayPathCache = sync.Map{}
	if err != nil {
		linef(opts, stderr, "❌ %s", err.Error())
		return code
	}
	if opts.version {
		linef(opts, stdout, "monorepo-hash v%s", CLI_VERSION)
		return 0
	}
	if code == 0 && (opts.mode == "" || opts.help) {
		if !opts.silent {
			printHelp(stdout)
		}
		return 0
	}

	if opts.mode == "generate" {
		if len(opts.targets) > 0 {
			linef(opts, stdout, "ℹ️  Generating hashes for specified targets... (%s)\n", strings.Join(opts.targets, ", "))
		} else {
			linef(opts, stdout, "ℹ️  Generating hashes for all workspaces...\n")
		}
	} else {
		if len(opts.targets) > 0 {
			linef(opts, stdout, "ℹ️  Comparing hashes for specified targets... (%s)\n", strings.Join(opts.targets, ", "))
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
		linef(opts, stderr, "❌ %s\n", err.Error())
		return 99
	}
	var d *detected
	if opts.pmOption != "" {
		d, err = detectSpecified(wd, opts.pmOption)
	} else {
		d, err = autoDetect(wd)
	}
	if err != nil {
		linef(opts, stderr, "❌ %s\n", err.Error())
		return 99
	}
	if d == nil {
		if opts.pmOption != "" {
			auto, _ := autoDetect(wd)
			if auto != nil {
				linef(opts, stderr, "❌ %s workspaces not found. Did you mean --packagemanager=%s?", opts.pmOption, auto.pm)
			} else {
				linef(opts, stderr, "❌ Specified package manager not found and no supported package manager detected")
			}
			return 5
		}
		linef(opts, stderr, "❌ No workspaces found or unsupported package manager")
		return 4
	}

	repoRoot, _ := filepath.Abs(d.root)
	linef(opts, stdout, "ℹ️  Using %s workspaces from %s\n", d.pm, repoRoot)

	rootIgnore := &ignoreMatcher{}
	rootGitignorePath := filepath.Join(repoRoot, ".gitignore")
	if content, err := os.ReadFile(rootGitignorePath); err == nil {
		rootIgnore = newIgnoreMatcher(string(content), nil)
	}

	pkgJSONPaths, err := collectWorkspacePackageJSONs(repoRoot, d.globs)
	if err != nil {
		linef(opts, stderr, "❌ %s\n", err.Error())
		return 99
	}
	if len(pkgJSONPaths) == 0 {
		linef(opts, stderr, "❌ No package.json files found in workspaces")
		return 4
	}

	meta := make(map[string]pkgMeta, len(pkgJSONPaths))
	relToName := make(map[string]string, len(pkgJSONPaths))
	manifests := make(map[string]packageManifest, len(pkgJSONPaths))
	for _, pkgPath := range pkgJSONPaths {
		content, err := os.ReadFile(pkgPath)
		if err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
		var manifest packageManifest
		if err := json.Unmarshal(content, &manifest); err != nil {
			linef(opts, stderr, "❌ Invalid JSON in %s\n", pkgPath)
			return 99
		}
		if manifest.Name == "" {
			linef(opts, stderr, "❌ Missing package name in %s\n", pkgPath)
			return 99
		}
		dir := filepath.Dir(pkgPath)
		relDirNative, _ := filepath.Rel(repoRoot, dir)
		relDir := toPosix(relDirNative)
		if relDir == "." {
			relDir = ""
		}
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
	pad := 1
	if total >= 1000 {
		pad = 4
	} else if total >= 100 {
		pad = 3
	} else if total >= 10 {
		pad = 2
	}
	logf(opts, stdout, true, "🔄 Computing hashes (%s/%d)", zeroPad(0, pad), total)

	pkgs := make(map[string]pkgInfo, len(toHash))
	debugRootOutput := map[string]map[string]string{}
	for idx, name := range toHash {
		m := meta[name]
		pkgIgnore := &ignoreMatcher{}
		if content, err := os.ReadFile(filepath.Join(m.dir, ".gitignore")); err == nil {
			domain := []string{}
			if m.relDir != "" {
				domain = strings.Split(toPosix(m.relDir), "/")
			}
			pkgIgnore = newIgnoreMatcher(string(content), domain)
		}
		files, err := getWorkspaceFileList(m.dir, m.relDir, rootIgnore, pkgIgnore)
		if err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
		perFile, err := computePerFileHashes(m.dir, files)
		if err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
		ownHash, err := computeOwnHashFromPerFile(perFile)
		if err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
		pkgs[name] = pkgInfo{dir: m.dir, relDir: m.relDir, deps: m.deps, perFileHashes: perFile, ownHash: ownHash}
		logf(opts, stdout, true, "🔄 Computing hashes (%s/%d) • %s", zeroPad(idx+1, pad), total, displayPath(m.relDir, false))
		if opts.debug && opts.mode == "generate" {
			if opts.unified {
				debugRootOutput[m.relDir] = perFile
			} else if err := writeDebugFile(m.dir, perFile); err != nil {
				linef(opts, stderr, "❌ %s\n", err.Error())
				return 99
			}
		}
	}
	if opts.mode == "generate" && opts.debug && opts.unified {
		if err := writeRootDebugFile(repoRoot, debugRootOutput); err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
	}
	logf(opts, stdout, true, "✅ Computed all hashes (%d)", total)
	linef(opts, stdout, "\n")

	finalCache := make(map[string]string, len(pkgs))
	for _, name := range toHash {
		if _, err := computeFinalHash(name, pkgs, finalCache, []string{}, map[string]int{}); err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 6
		}
	}

	if opts.mode == "generate" {
		if err := generateHashes(opts, stdout, repoRoot, pkgs, finalCache); err != nil {
			linef(opts, stderr, "❌ %s\n", err.Error())
			return 99
		}
		return 0
	}
	compareRes, err := compareHashes(opts, stdout, repoRoot, pkgs, finalCache)
	if err != nil {
		linef(opts, stderr, "❌ %s\n", err.Error())
		return 99
	}
	if len(compareRes.ChangedTargets) > 0 || len(compareRes.MissingTargets) > 0 {
		return 1
	}
	return 0
}

func main() {
	os.Exit(execute(os.Args[1:], os.Stdout, os.Stderr))
}
