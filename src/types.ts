/**
 * Structural aliases for the OpenCode V2 plugin context.
 *
 * We intentionally use a permissive context type so the plugin stays portable
 * across `@opencode/plugin` minor versions; every domain access is guarded at
 * runtime. Only `@opencode/plugin` is used as the SDK.
 */
export type PluginContext = any

export interface Registration {
  dispose(): Promise<void>
}
