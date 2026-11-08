const PAGE = 'pageInfo { hasNextPage endCursor }';
const ISSUE_FIELDS = `id identifier title description url priority createdAt updatedAt trashed
  state { id name type } labels { nodes { id name parent { id } } ${PAGE} } delegate { id } team { id key }`;

export const Q = {
  issue: `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  /** An issue's labels past the page `ISSUE_FIELDS` read (ORC-347). */
  issueLabels: `query IssueLabels($id: String!, $after: String) { issue(id: $id) { labels(first: 250, after: $after) { nodes { id name parent { id } } ${PAGE} } } }`,
  /** The lists below are read a page at a time, every page (ORC-347): `allNodes`. */
  delegated: `query Delegated($teamKey: String!, $appUserId: ID!, $after: String) {
    issues(first: 100, after: $after, filter: { team: { key: { eq: $teamKey } }, delegate: { id: { eq: $appUserId } },
      state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } ${PAGE} } }`,
  teamStates: `query TeamStates($teamKey: String!, $after: String) {
    workflowStates(first: 250, after: $after, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name type position } ${PAGE} } }`,
  teamLabels: `query TeamLabels($teamKey: String!, $after: String) {
    issueLabels(first: 250, after: $after, filter: { team: { key: { eq: $teamKey } } }) { nodes { id name parent { id } } ${PAGE} } }`,
  team: `query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name } } }`,
  /** The members of a team (ORC-186), a page at a time; `active` is false for a deactivated user. */
  teamMembers: `query TeamMembers($key: String!, $after: String) { teams(filter: { key: { eq: $key } }) { nodes {
    members(first: 250, after: $after) { nodes { id active } ${PAGE} } } } }`,
  viewer: `query Viewer { viewer { id name } organization { id name } }`,
  /** A team's issues alone (ORC-349): the factory's token reads the whole workspace. */
  search: `query Search($term: String!, $teamKey: String!) { searchIssues(term: $term, first: 10, filter: { team: { key: { eq: $teamKey } } }) { nodes { identifier title url state { name } } } }`,
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
