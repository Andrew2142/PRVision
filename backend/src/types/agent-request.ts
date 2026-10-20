/** One image of an agent AI request (17 §6.2): written by the provider, read by the agent from disk. */
export interface AgentRequestImage {
  label: string;
  /** Absolute path under <dataDir>/agent-requests/<visualizationId>/. */
  path: string;
}
