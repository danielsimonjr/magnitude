import { definePrompt } from '../prompt'
import { denyForbiddenCommands, denyMutatingGit, denyWritesOutside, denyWritesToProtectedPaths, denyMassDestructiveIn, allowAll } from '../policy'
import type { RoleDefinition } from '../types'
import engineerPromptRaw from '../prompts/engineer.txt' with { type: 'text' }
import { homedir } from 'node:os'
import { join } from 'node:path'

export function createEngineerRole(): RoleDefinition {
  return {
    id: 'engineer',
    description: 'Implements code changes',
    prompt: definePrompt<'SKILLS_SECTION' | 'THINKING_LIMIT' | 'CHECKPOINT_SECTION'>(engineerPromptRaw),
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
      coordinatorOnSpawn: 'If there are other independent changes to make, spawn additional engineers in parallel.',
      coordinatorOnIdle: "Review the engineer's work for correctness and quality.",
    },
    initialContext: { coordinatorConversation: true },
  }
}
