/** Network levels of the MVP doc: a step can only narrow the repository's level. */
export type NetworkLevel = 'none' | 'claude-api' | 'limited' | 'full';

export interface SandboxRequest {
  runId: string;
  ticketId: string;
  workspacePath: string;
  network: NetworkLevel;
}

export interface Sandbox {
  id: string;
  network: NetworkLevel;
}

export interface SandboxProvider {
  create(req: SandboxRequest): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
}
