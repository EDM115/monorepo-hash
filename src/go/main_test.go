package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func writeFile(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write failed: %v", err)
	}
}

func scaffoldRepo(t *testing.T, root string) {
	t.Helper()
	writeFile(t, filepath.Join(root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n")
	writeFile(t, filepath.Join(root, "packages", "pkg-c", "package.json"), `{"name":"pkg-c","version":"1.0.0","type":"module"}`)
	writeFile(t, filepath.Join(root, "packages", "pkg-c", "index.js"), "export const c = true\n")
	writeFile(t, filepath.Join(root, "packages", "pkg-b", "package.json"), `{"name":"pkg-b","version":"1.0.0","type":"module","dependencies":{"pkg-c":"workspace:*"}}`)
	writeFile(t, filepath.Join(root, "packages", "pkg-b", "index.js"), "export const b = true\n")
	writeFile(t, filepath.Join(root, "packages", "pkg-a", "package.json"), `{"name":"pkg-a","version":"1.0.0","type":"module","dependencies":{"pkg-b":"workspace:*"}}`)
	writeFile(t, filepath.Join(root, "packages", "pkg-a", "index.js"), "export const a = true\n")
}

func readRootHash(t *testing.T, root string) map[string]string {
	t.Helper()
	content, err := os.ReadFile(filepath.Join(root, ".hash"))
	if err != nil {
		t.Fatalf("read .hash failed: %v", err)
	}
	out := map[string]string{}
	if err := json.Unmarshal(content, &out); err != nil {
		t.Fatalf("parse .hash failed: %v", err)
	}
	return out
}

func TestGenerateParityWithNodeCLI(t *testing.T) {
	repoRoot := os.Getenv("MONOREPO_HASH_REPO_ROOT")
	if repoRoot == "" {
		_, currentFile, _, _ := runtime.Caller(0)
		repoRoot = filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", ".."))
	}

	tmp := t.TempDir()
	scaffoldRepo(t, tmp)

	nodeCLI := filepath.Join(repoRoot, "dist", "monorepo-hash.mjs")
	if _, err := os.Stat(nodeCLI); err != nil {
		t.Fatalf("node cli not found at %s (run pnpm build first): %v", nodeCLI, err)
	}

	nodeCmd := exec.Command("node", nodeCLI, "--generate", "--silent")
	nodeCmd.Dir = tmp
	if out, err := nodeCmd.CombinedOutput(); err != nil {
		t.Fatalf("node cli failed: %v\n%s", err, string(out))
	}
	nodeHash := readRootHash(t, tmp)

	if err := os.Remove(filepath.Join(tmp, ".hash")); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}

	prevWD, _ := os.Getwd()
	t.Cleanup(func() { _ = os.Chdir(prevWD) })
	if err := os.Chdir(tmp); err != nil {
		t.Fatalf("chdir failed: %v", err)
	}

	if code := execute([]string{"--generate", "--silent"}, os.Stdout, os.Stderr); code != 0 {
		t.Fatalf("go cli returned non-zero code: %d", code)
	}
	goHash := readRootHash(t, tmp)

	nodeBytes, _ := json.Marshal(nodeHash)
	goBytes, _ := json.Marshal(goHash)
	if string(nodeBytes) != string(goBytes) {
		t.Fatalf("hash mismatch\nnode=%s\ngo=%s", nodeBytes, goBytes)
	}
}
