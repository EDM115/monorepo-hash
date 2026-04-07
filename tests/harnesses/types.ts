type CliResult = {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

// oxlint-disable-next-line typescript/no-explicit-any
type RunCli = (cwd: string, args: string[], options?: Record<string, any>) => Promise<CliResult>

type ProbeCheck = {
  name: string;
  args: string[];
  exitCode: number;
  stdoutIncludes?: string[];
  stderrIncludes?: string[];
  stdoutRegex?: RegExp;
  stdoutExact?: string;
  stderrExact?: string;
}

type MatrixCase = {
  name: string;
  pre?: string[];
  run: string[];
  runCwd?: string;
  mutate?: (repoDir: string, caseName: string) => Promise<void>;
}

type SnapshotResult = {
  args: string[];
  pre: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutNorm: string;
  files: Record<string, string>;
}

export type {
  CliResult,
  RunCli,
  ProbeCheck,
  MatrixCase,
  SnapshotResult,
}
