declare module 'claude-code' {
  interface PluginState {
    'cc-status-bar': { line: string; effort: string; base: number | null }
  }
}
