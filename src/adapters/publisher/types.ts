/** The factory pushes the verified sha and opens or updates the branch's PR (today the agent pushes). */
export interface PublishRequest {
  projectId: string;
  repoPath: string;
  ticketId: string;
  branch: string;
  sha: string;
  title: string;
  body: string;
}

export interface Publication {
  prNumber: number;
  url: string;
  sha: string;
}

export interface Publisher {
  publish(req: PublishRequest): Promise<Publication>;
}
