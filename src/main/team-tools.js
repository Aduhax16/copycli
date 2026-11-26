// Tools agents use to work together.
const S = (properties = {}, required = []) => ({ type: 'object', properties, required });
export const TEAM_TOOLS = [
  { name: 'team_status', description: 'What each agent in this chat is doing now, the files it claimed and the files it changed.', inputSchema: S() },
  { name: 'team_messages', description: 'Read the recent shared chat, including work still in progress.', inputSchema: S({ count: { type: 'number' } }) },
  { name: 'team_post', description: 'Post a short note to the shared chat for the user and the other agents.', inputSchema: S({ text: { type: 'string' } }, ['text']) },
  { name: 'team_claim', description: 'Claim files before editing them while others are working. Fails, naming the owner, if a teammate holds one. Claims end with your turn.', inputSchema: S({ files: { type: 'array', items: { type: 'string' } } }, ['files']) },
  { name: 'ask_user', description: 'Ask the user a question in your own box in the chat, when you cannot go on well without their answer. Set pause_others to true only when the others\' work depends on the answer: they stop now and continue on their own once the user answers. After asking, end your turn with one short line; the answer arrives as your next message.', inputSchema: S({ question: { type: 'string' }, pause_others: { type: 'boolean' } }, ['question']) },
  { name: 'team_release', description: 'Release files you claimed (all when left out).', inputSchema: S({ files: { type: 'array', items: { type: 'string' } } }) },
];
