const ISSUE_FIELDS = `id identifier title description url priority createdAt
  state { id name type } labels { nodes { id name parent { id } } } delegate { id } team { id key }`;

export const Q = {
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  delegated: `query Delegated($teamKey: String!, $appUserId: ID!) {
    issues(first: 100, filter: { team: { key: { eq: $teamKey } }, delegate: { id: { eq: $appUserId } },
      state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } }`,
  teamStates: `query TeamStates($teamKey: String!) { workflowStates(first: 100, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name type position } } }`,
  teamLabels: `query TeamLabels($teamKey: String!) { issueLabels(first: 250, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name parent { id } } } }`,
  team: `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`,
  /** The members of a team (ORC-186), a page at a time; `active` is false for a deactivated user. */
  teamMembers: `query TeamMembers($key: String!, $after: String) { teams(filter: { key: { eq: $key } }) { nodes {
    members(first: 250, after: $after) { nodes { id active } pageInfo { hasNextPage endCursor } } } } }`,
  viewer: `query Viewer { viewer { id name } organization { id name } }`,
  search: `query Search($term: String!) { searchIssues(term: $term, first: 10) { nodes { identifier title url state { name } } } }`,
  issueUpdate: `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
  commentCreate: `mutation CommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
  /** The ticket's comment of an effect (ORC-162): by the id it was created with, or by its marker in case the id was not kept. */
  effectComment: `query EffectComment($issueId: ID!, $id: ID!, $marker: String!) {
    comments(first: 1, filter: { issue: { id: { eq: $issueId } }, or: [{ id: { eq: $id } }, { body: { contains: $marker } }] }) { nodes { id } } }`,
  /** The session's activity of an effect (ORC-162): an activity has no body filter, only its id. */
  effectActivity: `query EffectActivity($sessionId: String!, $id: ID!) {
    agentSession(id: $sessionId) { activities(first: 1, filter: { id: { eq: $id } }) { nodes { id } } } }`,
  sessionLinks: `query SessionLinks($id: String!) { agentSession(id: $id) { externalLinks { url } } }`,
  activityCreate: `mutation ActivityCreate($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
  sessionUpdate: `mutation SessionUpdate($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
  sessionOnIssue: `mutation SessionOnIssue($input: AgentSessionCreateOnIssue!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id } } }`,
  stateCreate: `mutation StateCreate($input: WorkflowStateCreateInput!) { workflowStateCreate(input: $input) { success workflowState { id name } } }`,
  labelCreate: `mutation LabelCreate($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id name } } }`,
} as const;
