/** Cursor Cloud Agents API types */

export interface AgentSource {
  repository: string;
  ref?: string;
  prUrl?: string;
}

export interface AgentTarget {
  branchName?: string;
  url?: string;
  prUrl?: string;
  autoCreatePr?: boolean;
  openAsCursorGithubApp?: boolean;
  skipReviewerRequest?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  source: AgentSource;
  target: AgentTarget;
  summary?: string;
  createdAt: string;
}

export type AgentStatus =
  | "CREATING"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "STOPPED";

export interface LaunchAgentRequest {
  prompt: { text: string; images?: Array<{ data: string; dimension: { width: number; height: number } }> };
  model?: string;
  source: AgentSource;
  target?: {
    branchName?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  webhook?: {
    url: string;
    secret?: string;
  };
}

export interface WebhookPayload {
  event: "statusChange";
  timestamp: string;
  id: string;
  status: AgentStatus;
  source?: AgentSource;
  target?: AgentTarget;
  summary?: string;
}
