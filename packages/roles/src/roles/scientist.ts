import { definePrompt } from '../prompt'
import { denyForbiddenCommands, denyMutatingGit, denyWritesOutside, denyWritesToProtectedPaths, denyMassDestructiveIn, allowAll } from '../policy'
import type { RoleDefinition } from '../types'
import scientistPromptRaw from '../prompts/scientist.txt' with { type: 'text' }
import { homedir } from 'node:os'
import { join } from 'node:path'

export function createScientistRole(): RoleDefinition {
  return {
    id: 'scientist',
    description: 'Debugs and diagnoses issues',
    prompt: definePrompt<'SKILLS_SECTION' | 'THINKING_LIMIT' | 'CHECKPOINT_SECTION'>(scientistPromptRaw),
    defaultRecipient: 'coordinator',
    agentKind: 'worker',
    spawnable: true,
    maxThoughtChars: 20000,
    policy: [
      denyForbiddenCommands(),
      denyMutatingGit(),
      denyWritesToProtectedPaths(),
      denyWritesOutside(ctx => [ctx.cwd, ctx.scratchpadPath]),
      denyMassDestructiveIn(ctx => [join(homedir(), '.magnitude')]),
      allowAll(),
    ],
    lifecycle: {
      coordinatorOnSpawn: undefined,
      coordinatorOnIdle: "Review the scientist's diagnosis and determine next steps.",
    },
    initialContext: { coordinatorConversation: true },
  }
}
