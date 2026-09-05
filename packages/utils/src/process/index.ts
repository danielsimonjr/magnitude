export {
  InteractiveProcessFailed,
  interactiveProcessExitCode,
  runInteractiveProcess,
  type InteractiveProcess,
  type InteractiveProcessTermination,
} from "./interactive-process"
export {
  POSIX_SHELL_NOT_FOUND_MESSAGE,
  requirePosixShell,
  resolvePosixShell,
  shellDisplayName,
  windowsBashCandidates,
  type PosixShell,
  type PosixShellResolution,
  type ResolvePosixShellOptions,
} from "./posix-shell"
