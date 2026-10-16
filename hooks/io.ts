export type Io = {
  fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<{ mtimeMs: number }>
  }
  process: {
    run(
      argv: readonly string[],
      init?: { timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>
  }
  ui: {
    notify(
      text: string,
      opts: { title: string },
    ): Promise<{ isSent: true; channel: string } | { isSent: false; reason: string }>
  }
}
