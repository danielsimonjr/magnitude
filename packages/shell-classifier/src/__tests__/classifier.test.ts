import { test, expect, describe } from 'bun:test'
import { classifyShellCommand, isGitAllowed, isPathWithin, writesStayWithin } from '../classifier'

describe('shell-classifier', () => {

  describe('tier classification', () => {
    test('readonly commands classify as readonly', () => {
      expect(classifyShellCommand('cat file.txt').tier).toBe('readonly')
      expect(classifyShellCommand('ls -la').tier).toBe('readonly')
      expect(classifyShellCommand('grep pattern file').tier).toBe('readonly')
      expect(classifyShellCommand('git status').tier).toBe('readonly')
      expect(classifyShellCommand('git log --oneline').tier).toBe('readonly')
    })

    test('normal commands (unrecognized) classify as normal', () => {
      expect(classifyShellCommand('npm test').tier).toBe('normal')
      expect(classifyShellCommand('npm install').tier).toBe('normal')
      expect(classifyShellCommand('python script.py').tier).toBe('normal')
      expect(classifyShellCommand('make build').tier).toBe('normal')
    })

    test('formerly dangerous commands now classify as normal/forbidden', () => {
      expect(classifyShellCommand('rm -rf foo').tier).toBe('mass-destructive')
      expect(classifyShellCommand('git push --force').tier).toBe('forbidden')
      expect(classifyShellCommand('git reset --hard').tier).toBe('forbidden')
      expect(classifyShellCommand('git clean -f').tier).toBe('forbidden')
      expect(classifyShellCommand('kill -9 1234').tier).toBe('normal')
      expect(classifyShellCommand('killall node').tier).toBe('normal')
      expect(classifyShellCommand('chmod 777 file').tier).toBe('normal')
      expect(classifyShellCommand('chown root file').tier).toBe('normal')
    })

    test('forbidden commands classify as forbidden', () => {
      expect(classifyShellCommand('mkfs /dev/sda').tier).toBe('forbidden')
      expect(classifyShellCommand('rm -rf /usr').tier).toBe('forbidden')
      expect(classifyShellCommand('rm -rf /').tier).toBe('forbidden')
    })
  })

  describe('mass-destructive tier', () => {
    test('mass-destructive cases classify as mass-destructive', () => {
      for (const cmd of [
        'rm -r dir',
        'rm -R dir',
        'rm -rf dir',
        'rm -fr dir',
        'rm -Rf dir',
        'rm --recursive dir',
        'find . -type f -delete',
        'find . -name "*.tmp" -exec rm {} \\;',
        'find . -execdir rm {} +',
        'rsync -a --delete src/ dst/',
        'rsync --delete-before src/ dst/',
        'rsync --delete-during src/ dst/',
        'rsync --delete-delay src/ dst/',
        'rsync --delete-after src/ dst/',
        'sudo rm -rf dir',
      ]) {
        expect(classifyShellCommand(cmd).tier).toBe('mass-destructive')
      }
    })

    test('non-mass-destructive cases remain normal', () => {
      for (const cmd of [
        'rm file',
        'rm -f file',
        'rm -i file',
        'truncate -s 0 file',
        'shred file',
        'mv -f a b',
        'cp --remove-destination a b',
        'ln -sf a b',
        'echo hi > file',
        'rsync -a src/ dst/',
      ]) {
        expect(classifyShellCommand(cmd).tier).toBe('normal')
      }

      expect(classifyShellCommand('find . -type f -name "*.log"').tier).toBe('readonly')
    })

    test('forbidden takes priority over mass-destructive', () => {
      expect(classifyShellCommand('rm -rf /usr').tier).toBe('forbidden')
      expect(classifyShellCommand('rm -rf /').tier).toBe('forbidden')
    })

    test('pipeline and substitution bubble up mass-destructive tier', () => {
      expect(classifyShellCommand('echo hi | rm -rf dir').tier).toBe('mass-destructive')
      expect(classifyShellCommand('x=$(rm -rf dir)').tier).toBe('mass-destructive')
    })
  })

  describe('git forbidden cases', () => {
    for (const cmd of [
      'git commit -m "msg"',
      'git push',
      'git reset --hard',
      'git checkout main',
      'git merge main',
      'git stash',
      'git rebase main',
      'git add .',
      'git clean -f',
    ]) {
      test(`${cmd} is forbidden`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('forbidden')
      })
    }
  })

  describe('sed', () => {
    test('sed -n Np is readonly', () => {
      expect(classifyShellCommand('sed -n 5p').tier).toBe('readonly')
      expect(classifyShellCommand('sed -n 1,10p').tier).toBe('readonly')
    })

    test('sed substitution is readonly', () => {
      expect(classifyShellCommand("sed 's/foo/bar/'").tier).toBe('readonly')
      expect(classifyShellCommand("sed 's#^./##'").tier).toBe('readonly')
    })

    test('sed -e expressions is readonly', () => {
      expect(classifyShellCommand("sed -e 's/foo/bar/' -e 's/baz/qux/'").tier).toBe('readonly')
    })

    test('sed -n with pattern is readonly', () => {
      expect(classifyShellCommand("sed -n '/pattern/p'").tier).toBe('readonly')
    })

    test('sed delete pattern is readonly', () => {
      expect(classifyShellCommand("sed '/^#/d'").tier).toBe('readonly')
    })

    test('sed reading a file without -i is readonly', () => {
      expect(classifyShellCommand("sed 's/foo/bar/' file.txt").tier).toBe('readonly')
    })

    test('sed -ne expression is readonly (-e consumes rest)', () => {
      expect(classifyShellCommand("sed -ne 's/foo/bar/p'").tier).toBe('readonly')
    })

    test('sed -nE is readonly', () => {
      expect(classifyShellCommand("sed -nE 's/foo/bar/'").tier).toBe('readonly')
    })

    test('sed -i is NOT readonly', () => {
      expect(classifyShellCommand("sed -i 's/foo/bar/' file.txt")).not.toBe('readonly')
    })

    test('sed -i.bak is NOT readonly', () => {
      expect(classifyShellCommand("sed -i.bak 's/foo/bar/' file.txt")).not.toBe('readonly')
    })

    test('sed --in-place is NOT readonly', () => {
      expect(classifyShellCommand("sed --in-place 's/foo/bar/' file.txt")).not.toBe('readonly')
      expect(classifyShellCommand("sed --in-place=.bak 's/foo/bar/' file.txt")).not.toBe('readonly')
    })

    test('sed -f is NOT readonly', () => {
      expect(classifyShellCommand("sed -f script.sed file.txt")).not.toBe('readonly')
    })

    test('sed combined flags with i is NOT readonly', () => {
      expect(classifyShellCommand("sed -ni 's/foo/bar/' file.txt")).not.toBe('readonly')
      expect(classifyShellCommand("sed -Ei 's/foo/bar/' file.txt")).not.toBe('readonly')
    })

    test('sed with redirect is escalated to normal', () => {
      expect(classifyShellCommand("sed 's/foo/bar/' file.txt > output.txt")).not.toBe('readonly')
    })
  })

  describe('awk', () => {
    // awk can execute programs via system() / pipes, so it is never readonly.
    test('awk is normal (can execute programs)', () => {
      expect(classifyShellCommand("awk '{print $1}'").tier).toBe('normal')
      expect(classifyShellCommand("awk '{print $1}' file.txt").tier).toBe('normal')
      expect(classifyShellCommand(`awk 'BEGIN{system("git push")}'`).tier).not.toBe('readonly')
    })

    test('gawk/mawk/nawk are normal', () => {
      expect(classifyShellCommand("gawk '{print $1}'").tier).toBe('normal')
      expect(classifyShellCommand("mawk '{print $1}'").tier).toBe('normal')
      expect(classifyShellCommand("nawk '{print $1}'").tier).toBe('normal')
    })
  })

  describe('jq', () => {
    test('jq is readonly', () => {
      expect(classifyShellCommand("jq '.data[]'").tier).toBe('readonly')
      expect(classifyShellCommand("jq '.name' package.json").tier).toBe('readonly')
    })
  })

  describe('yq', () => {
    test('yq is readonly', () => {
      expect(classifyShellCommand("yq '.metadata.name' config.yaml").tier).toBe('readonly')
    })

    test('yq -i is NOT readonly', () => {
      expect(classifyShellCommand("yq -i '.version = \"2.0\"' config.yaml")).not.toBe('readonly')
    })

    test('yq --inplace is NOT readonly', () => {
      expect(classifyShellCommand("yq --inplace '.version = \"2.0\"' config.yaml")).not.toBe('readonly')
    })
  })

  describe('fd', () => {
    test('fd is readonly', () => {
      expect(classifyShellCommand("fd 'pattern'").tier).toBe('readonly')
      expect(classifyShellCommand('fd -e ts').tier).toBe('readonly')
    })

    test('fd --exec is NOT readonly', () => {
      expect(classifyShellCommand('fd -x rm')).not.toBe('readonly')
      expect(classifyShellCommand('fd --exec rm')).not.toBe('readonly')
      expect(classifyShellCommand('fd --exec-batch rm')).not.toBe('readonly')
    })
  })

  describe('ag', () => {
    test('ag is readonly', () => {
      expect(classifyShellCommand("ag 'pattern'").tier).toBe('readonly')
    })
  })

  describe('piped commands', () => {
    test('find | sed | sort is readonly', () => {
      expect(classifyShellCommand(
        "find packages -maxdepth 2 -name package.json | sed 's#^./##' | sort"
      ).tier).toBe('readonly')
    })

    test('cat | awk | sort is normal (awk can execute programs)', () => {
      expect(classifyShellCommand(
        "cat file.txt | awk '{print $2}' | sort -u"
      ).tier).toBe('normal')
    })

    test('cat | cut | sort is readonly', () => {
      expect(classifyShellCommand(
        "cat file.txt | cut -f2 | sort -u"
      ).tier).toBe('readonly')
    })

    test('cat | jq is readonly', () => {
      expect(classifyShellCommand(
        "cat data.json | jq '.items[] | .name'"
      ).tier).toBe('readonly')
    })

    test('pipe with unsafe sed is NOT readonly', () => {
      expect(classifyShellCommand(
        "cat file.txt | sed -i 's/foo/bar/' file.txt"
      )).not.toBe('readonly')
    })
  })

  describe('readonly commands', () => {
    for (const cmd of ['tree', 'column', 'fmt', 'fold', 'comm', 'diff', 'strings', 'od', 'hexdump']) {
      test(`${cmd} is readonly`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('readonly')
      })
    }
    for (const cmd of ['cat', 'ls', 'grep', 'head', 'tail', 'wc', 'sort', 'tr', 'echo', 'pwd']) {
      test(`${cmd} is readonly`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('readonly')
      })
    }
  })

  describe('command substitution', () => {
    test('command with $() piped subshell is classified correctly', () => {
      expect(classifyShellCommand('latest=$(ls -t dir | head -1); echo $latest').tier).toBe('readonly')
    })

    test('full session inspection command is readonly', () => {
      expect(classifyShellCommand(
        "latest=$(ls -t ~/.magnitude/sessions | head -1); echo $latest; ls -la ~/.magnitude/sessions/$latest; echo '--- meta.json ---'; cat ~/.magnitude/sessions/$latest/meta.json; echo '--- first 20 events ---'; head -20 ~/.magnitude/sessions/$latest/events.jsonl; echo '--- first 20 logs ---'; head -20 ~/.magnitude/sessions/$latest/logs.jsonl"
      ).tier).toBe('readonly')
    })

    test('$() with unsafe inner command is not readonly', () => {
      expect(classifyShellCommand('result=$(npm test)').tier).toBe('normal')
    })

    test('$() with forbidden inner command is forbidden', () => {
      expect(classifyShellCommand('result=$(rm -rf /usr)').tier).toBe('forbidden')
    })

    test('composite command with forbidden git is forbidden', () => {
      expect(classifyShellCommand('echo ok && git push').tier).toBe('forbidden')
    })
  })

  describe('variable assignments', () => {
    test('bare assignment is readonly', () => {
      expect(classifyShellCommand('FOO=bar').tier).toBe('readonly')
    })

    test('env prefix form is normal', () => {
      expect(classifyShellCommand('FOO=bar npm test').tier).toBe('normal')
    })

    test('assignment with readonly $() is readonly', () => {
      expect(classifyShellCommand('latest=$(ls -t dir | head -1)').tier).toBe('readonly')
    })

    test('assignment with unsafe $() is normal', () => {
      expect(classifyShellCommand('result=$(npm install)').tier).toBe('normal')
    })
  })

  describe('writesStayWithin', () => {
    test('echo foo > /outside/file with cwd /project => false', () => {
      expect(writesStayWithin('echo foo > /outside/file', {}, '/project')).toBe(false)
    })

    test('echo foo >> /outside/file => false', () => {
      expect(writesStayWithin('echo foo >> /outside/file', {}, '/project')).toBe(false)
    })

    test('cmd 2> /tmp/err => true (tmp is allowlisted)', () => {
      expect(writesStayWithin('cmd 2> /tmp/err', {}, '/project')).toBe(true)
    })

    test('echo foo > ./inside/file with cwd /project => true', () => {
      expect(writesStayWithin('echo foo > ./inside/file', {}, '/project')).toBe(true)
    })

    test('ls | tee /outside/out => false', () => {
      expect(writesStayWithin('ls | tee /outside/out', {}, '/project')).toBe(false)
    })

    test('cat file && rm /etc/foo => false', () => {
      expect(writesStayWithin('cat file && rm /etc/foo', {}, '/project')).toBe(false)
    })

    test('rm ../outside with cwd /project/sub => false', () => {
      expect(writesStayWithin('rm ../outside', {}, '/project/sub')).toBe(false)
    })

    test('rm ./inside => true', () => {
      expect(writesStayWithin('rm ./inside', {}, '/project')).toBe(true)
    })

    test('npm install => true', () => {
      expect(writesStayWithin('npm install', {}, '/project')).toBe(true)
    })

    test('tee /tmp/out => true (tmp is allowlisted)', () => {
      expect(writesStayWithin('ls | tee /tmp/out', {}, '/project')).toBe(true)
    })

    test('echo foo > /dev/null => true (dev/null is allowlisted)', () => {
      expect(writesStayWithin('echo foo > /dev/null', {}, '/project')).toBe(true)
    })

    test('cp file /dev/sda => false (only /dev/null is allowlisted)', () => {
      expect(writesStayWithin('cp file /dev/sda', {}, '/project')).toBe(false)
    })

    test('workspace path is allowed when passed as additional root', () => {
      expect(writesStayWithin('echo foo > /Users/alice/.magnitude/sessions/123/workspace/note.txt', {}, '/project', '/Users/alice/.magnitude/sessions/123/workspace/')).toBe(true)
      expect(writesStayWithin('mkdir -p /Users/alice/.magnitude/sessions/123/workspace/tmp', {}, '/project', '/Users/alice/.magnitude/sessions/123/workspace')).toBe(true)
    })

    test('outside paths remain blocked even with workspace allowlist', () => {
      expect(writesStayWithin('echo foo > /Users/alice/.ssh/config', {}, '/project', '/Users/alice/.magnitude/sessions/123/workspace/')).toBe(false)
    })
  })

  describe('writesStayWithin with cd tracking', () => {
    test('absolute cd: cd /tmp && rm ./foo => true (tmp is allowlisted)', () => {
      expect(writesStayWithin('cd /tmp && rm ./foo', {}, '/project')).toBe(true)
    })

    test('absolute cd: cd /etc && rm ./foo => false', () => {
      expect(writesStayWithin('cd /etc && rm ./foo', {}, '/project')).toBe(false)
    })

    test('relative cd: cd sub && rm ./file => true', () => {
      expect(writesStayWithin('cd sub && rm ./file', {}, '/project')).toBe(true)
    })

    test('relative cd: cd .. && rm ./file from /project/sub => false (resolves outside root)', () => {
      expect(writesStayWithin('cd .. && rm ./file', {}, '/project/sub')).toBe(false)
    })

    test('relative cd: cd ../.. && rm ./file from /project/sub => false', () => {
      expect(writesStayWithin('cd ../.. && rm ./file', {}, '/project/sub')).toBe(false)
    })

    test('env target cd: cd $HOME && rm foo => false when HOME outside project', () => {
      expect(writesStayWithin('cd $HOME && rm foo', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('env target cd: cd $M && rm foo => true when workspace allowlisted', () => {
      expect(writesStayWithin('cd $M && rm foo', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
    })

    test('cd foo/$UNDEFINED/bar && rm baz => false (fail-closed for undefined env var)', () => {
      expect(writesStayWithin('cd foo/$UNDEFINED/bar && rm baz', {}, '/project')).toBe(false)
    })

    test('cd $M/sub && rm file => false when $M undefined', () => {
      expect(writesStayWithin('cd $M/sub && rm file', {}, '/project', '/workspace')).toBe(false)
    })

    test('tilde cd target: cd ~/tmp && rm foo => false when HOME outside project', () => {
      expect(writesStayWithin('cd ~/tmp && rm foo', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('cd ~/foo && rm bar => false when HOME/USERPROFILE missing', () => {
      expect(writesStayWithin('cd ~/foo && rm bar', {}, '/project')).toBe(false)
    })

    test('cd ~ && rm bar => false when HOME/USERPROFILE missing', () => {
      expect(writesStayWithin('cd ~ && rm bar', {}, '/project')).toBe(false)
    })

    test('cd - returns to previous allowlisted dir', () => {
      expect(writesStayWithin('cd /tmp && cd /project && cd - && rm foo', {}, '/project')).toBe(true)
    })

    test('cd - returns to previous non-allowlisted dir', () => {
      expect(writesStayWithin('cd /etc && cd /project && cd - && rm foo', {}, '/project')).toBe(false)
    })

    test('cd with no args uses HOME outside project => false', () => {
      expect(writesStayWithin('cd && rm foo', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('cd with no args uses HOME inside project => true', () => {
      expect(writesStayWithin('cd && rm foo', { HOME: '/project/home' }, '/project')).toBe(true)
    })

    test('cd with no args and no HOME/USERPROFILE => false (fail-closed)', () => {
      expect(writesStayWithin('cd && rm foo', {}, '/project')).toBe(false)
    })

    test('cd - at start with no previous cwd => false (fail-closed)', () => {
      expect(writesStayWithin('cd - && rm foo', {}, '/project')).toBe(false)
    })

    test('sequential cd chaining inside root => true', () => {
      expect(writesStayWithin('cd foo && cd bar && rm baz', {}, '/project')).toBe(true)
    })

    test('sequential cd chaining escaping root => false', () => {
      expect(writesStayWithin('cd foo && cd ../../.. && rm baz', {}, '/project')).toBe(false)
    })

    test('mixed commands: non-cd then cd then write', () => {
      expect(writesStayWithin('ls && cd /tmp && rm foo', {}, '/project')).toBe(true)
    })

    test('mixed commands with later cd to disallowed dir => false', () => {
      expect(writesStayWithin('cd /tmp && ls && cd /etc && rm foo', {}, '/project')).toBe(false)
    })

    test('redirects after cd: cd /tmp && echo x > out.txt => true', () => {
      expect(writesStayWithin('cd /tmp && echo x > out.txt', {}, '/project')).toBe(true)
    })

    test('redirects after cd: cd /etc && echo x > out.txt => false', () => {
      expect(writesStayWithin('cd /etc && echo x > out.txt', {}, '/project')).toBe(false)
    })

    test('subshell characterization: parser flattens subshell boundaries for cwd tracking', () => {
      expect(writesStayWithin('cd /tmp; (cd /etc && rm foo)', {}, '/project')).toBe(false)
    })

    describe('$M workspace env var scenarios', () => {
      test('cd $M && rm file => true when $M is additional root', () => {
        expect(writesStayWithin('cd $M && rm file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M/sub && rm file => true when $M is additional root', () => {
        expect(writesStayWithin('cd $M/sub && rm file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M && rm /project/file => true (project is primary root)', () => {
        expect(writesStayWithin('cd $M && rm /project/file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M && rm ../../etc/passwd => false (escapes workspace)', () => {
        expect(writesStayWithin('cd $M && rm ../../etc/passwd', { M: '/workspace' }, '/project', '/workspace')).toBe(false)
      })

      test('cd /project/sub && echo x > $M/out.txt => true when $M is additional root', () => {
        expect(writesStayWithin('cd /project/sub && echo x > $M/out.txt', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M && echo x > log.txt => true', () => {
        expect(writesStayWithin('cd $M && echo x > log.txt', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M && echo x > /etc/evil => false', () => {
        expect(writesStayWithin('cd $M && echo x > /etc/evil', { M: '/workspace' }, '/project', '/workspace')).toBe(false)
      })

      test('cd $M && rm file => false when $M is NOT an additional root', () => {
        expect(writesStayWithin('cd $M && rm file', { M: '/workspace' }, '/project')).toBe(false)
      })

      test('cd /project && rm $M/file => true when $M is additional root', () => {
        expect(writesStayWithin('cd /project && rm $M/file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
      })

      test('cd $M && rm file => handles missing $M gracefully', () => {
        expect(writesStayWithin('cd $M && rm file', {}, '/project')).toBe(false)
      })
    })

    describe('composite and edge-case scenarios', () => {
      describe('Combined shell expansion + cd', () => {
        test('cd $HOME/projects && rm ./secret => true', () => {
          expect(writesStayWithin('cd $HOME/projects && rm ./secret', { HOME: '/Users/alice' }, '/Users/alice/projects')).toBe(true)
        })

        test('cd $HOME/projects && rm ../secret => false', () => {
          expect(writesStayWithin('cd $HOME/projects && rm ../secret', { HOME: '/Users/alice' }, '/Users/alice/projects')).toBe(false)
        })

        test('cd $M && rm $HOME/.ssh/key => false', () => {
          expect(writesStayWithin('cd $M && rm $HOME/.ssh/key', { M: '/workspace', HOME: '/Users/alice' }, '/project', '/workspace')).toBe(false)
        })

        test('cd $M/sub && rm ./file => true', () => {
          expect(writesStayWithin('cd $M/sub && rm ./file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
        })
      })

      describe('cd + env var in write args (not just cd target)', () => {
        test('cd /tmp && rm $HOME/.bashrc => false', () => {
          expect(writesStayWithin('cd /tmp && rm $HOME/.bashrc', { HOME: '/Users/alice' }, '/project')).toBe(false)
        })

        test('cd /project/sub && cp $HOME/file ./dest => false (classifier checks all args including source)', () => {
          expect(writesStayWithin('cd /project/sub && cp $HOME/file ./dest', { HOME: '/Users/alice' }, '/project')).toBe(false)
        })
      })

      describe('Multiple write commands after cd', () => {
        test('cd /tmp && rm foo && rm bar => true', () => {
          expect(writesStayWithin('cd /tmp && rm foo && rm bar', {}, '/project')).toBe(true)
        })

        test('cd /tmp && rm foo && cd /etc && rm bar => false', () => {
          expect(writesStayWithin('cd /tmp && rm foo && cd /etc && rm bar', {}, '/project')).toBe(false)
        })
      })

      describe('cd interleaved with redirects and writes', () => {
        test('cd /project/sub && echo x > log.txt && cd /etc && echo y > evil.txt => false', () => {
          expect(writesStayWithin('cd /project/sub && echo x > log.txt && cd /etc && echo y > evil.txt', {}, '/project')).toBe(false)
        })

        test('cd /project/sub && echo x > log.txt && echo y > ../other.txt => true', () => {
          expect(writesStayWithin('cd /project/sub && echo x > log.txt && echo y > ../other.txt', {}, '/project')).toBe(true)
        })
      })

      describe('Relative cd chains with writes between', () => {
        test('cd sub1 && rm file1 && cd sub2 && rm file2 => true', () => {
          expect(writesStayWithin('cd sub1 && rm file1 && cd sub2 && rm file2', {}, '/project')).toBe(true)
        })

        test('cd sub1 && rm file1 && cd ../../.. && rm file2 => false', () => {
          expect(writesStayWithin('cd sub1 && rm file1 && cd ../../.. && rm file2', {}, '/project')).toBe(false)
        })
      })

      describe('cd with write to /dev/null (always allowed)', () => {
        test('cd /etc && echo x > /dev/null => true', () => {
          expect(writesStayWithin('cd /etc && echo x > /dev/null', {}, '/project')).toBe(true)
        })
      })

      describe('cd to allowed additional root', () => {
        test('cd /workspace/deep/dir && rm file => true', () => {
          expect(writesStayWithin('cd /workspace/deep/dir && rm file', {}, '/project', '/workspace')).toBe(true)
        })
      })

      describe('No-op scenarios (cd does not affect non-write commands)', () => {
        test('cd /etc && ls => true', () => {
          expect(writesStayWithin('cd /etc && ls', {}, '/project')).toBe(true)
        })

        test('cd /etc && echo hello => true', () => {
          expect(writesStayWithin('cd /etc && echo hello', {}, '/project')).toBe(true)
        })
      })
    })
  })

  describe('env var expansion in isPathWithin', () => {
    test('$HOME outside allowed roots is rejected', () => {
      expect(isPathWithin('$HOME/.bashrc', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('$HOME inside allowed roots is allowed', () => {
      expect(isPathWithin('$HOME/sub', { HOME: '/project/sub' }, '/project')).toBe(true)
    })

    test('${VAR} syntax expanded', () => {
      expect(isPathWithin('${PROJECT_ROOT}/../secret', { PROJECT_ROOT: '/project' }, '/project')).toBe(false)
    })

    test('$M within workspace allowed', () => {
      expect(isPathWithin('$M/notes.md', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
    })

    test('unknown var collapses to empty string', () => {
      expect(isPathWithin('foo/$NONEXISTENT/bar', {}, '/project')).toBe(true)
    })
  })

  describe('env var expansion in writesStayWithin', () => {
    test('redirect to $HOME outside roots rejected', () => {
      expect(writesStayWithin('echo x > $HOME/leak', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('cp to $HOME rejected', () => {
      expect(writesStayWithin('cp file $HOME/.ssh/key', { HOME: '/Users/alice' }, '/project')).toBe(false)
    })

    test('redirect to $M within workspace allowed', () => {
      expect(writesStayWithin('echo x > $M/file', { M: '/workspace' }, '/project', '/workspace')).toBe(true)
    })
  })

  describe('isGitAllowed', () => {
    test('read-only git commands are allowed', () => {
      expect(isGitAllowed('git status')).toBe(true)
      expect(isGitAllowed('git log --oneline')).toBe(true)
      expect(isGitAllowed('git diff')).toBe(true)
      expect(isGitAllowed('git show HEAD')).toBe(true)
      expect(isGitAllowed('git branch --list')).toBe(true)
      expect(isGitAllowed('git branch -a')).toBe(true)
    })

    test('write git commands are not allowed', () => {
      expect(isGitAllowed('git push')).toBe(false)
      expect(isGitAllowed('git push --force')).toBe(false)
      expect(isGitAllowed('git commit -m "msg"')).toBe(false)
      expect(isGitAllowed('git add .')).toBe(false)
      expect(isGitAllowed('git checkout main')).toBe(false)
      expect(isGitAllowed('git reset --hard')).toBe(false)
      expect(isGitAllowed('git stash')).toBe(false)
      expect(isGitAllowed('git rebase main')).toBe(false)
    })

    test('non-git commands are allowed', () => {
      expect(isGitAllowed('npm test')).toBe(true)
      expect(isGitAllowed('ls -la')).toBe(true)
      expect(isGitAllowed('cat file.txt')).toBe(true)
    })

    test('mixed commands: non-git + allowed git', () => {
      expect(isGitAllowed('npm test && git log')).toBe(true)
      expect(isGitAllowed('npm test && git status')).toBe(true)
    })

    test('mixed commands: non-git + disallowed git', () => {
      expect(isGitAllowed('npm test && git push')).toBe(false)
      expect(isGitAllowed('git status && git commit -m "msg"')).toBe(false)
    })

    test('git with -c config override is not allowed', () => {
      expect(isGitAllowed('git -c user.name=x status')).toBe(false)
    })
  })
})

describe('shell-classifier security regressions', () => {

  describe('H1: path resolution when tracked cwd is /', () => {
    test('cd / && rm -rf etc is outside the roots and mass-destructive', () => {
      expect(writesStayWithin('cd / && rm -rf etc', {}, '/project')).toBe(false)
      expect(classifyShellCommand('cd / && rm -rf etc').tier).toBe('mass-destructive')
    })

    test('cd .. && rm -rf x from a project root is outside', () => {
      expect(writesStayWithin('cd .. && rm -rf x', {}, '/project')).toBe(false)
      expect(writesStayWithin('cd .. && rm -rf project/x', {}, '/project')).toBe(true)
    })

    test('root / as an allowed root contains everything', () => {
      expect(isPathWithin('etc', {}, '/')).toBe(true)
      expect(isPathWithin('/etc/passwd', {}, '/')).toBe(true)
    })

    test('trailing slash on the root is normalized', () => {
      expect(writesStayWithin('rm x', {}, '/project/')).toBe(true)
      expect(writesStayWithin('rm /projectx/y', {}, '/project/')).toBe(false)
    })
  })

  describe('H2: command substitution in words', () => {
    test('$() and backticks in args run their inner command', () => {
      expect(classifyShellCommand('echo $(git push origin main)').tier).toBe('forbidden')
      expect(classifyShellCommand('cat `git push`').tier).toBe('forbidden')
      expect(classifyShellCommand('ls $(rm -rf /etc)').tier).toBe('forbidden')
      expect(classifyShellCommand('echo "$(rm -rf dir)"').tier).toBe('mass-destructive')
    })

    test('substitution in command name or redirect target', () => {
      expect(classifyShellCommand('$(echo git) push').tier).not.toBe('readonly')
      expect(classifyShellCommand('echo hi > $(git push)').tier).toBe('forbidden')
      expect(classifyShellCommand('`echo rm` -rf /usr').tier).not.toBe('readonly')
    })

    test('readonly substitutions stay readonly', () => {
      expect(classifyShellCommand('echo $(ls)').tier).toBe('readonly')
      expect(classifyShellCommand('cat `ls -t | head -1`').tier).toBe('readonly')
    })

    test('unbalanced substitution syntax is never readonly', () => {
      expect(classifyShellCommand('echo "$(ls"').tier).toBe('normal')
    })

    test('isGitAllowed fails closed on substitutions that could hide git', () => {
      expect(isGitAllowed('echo $(git push origin main)')).toBe(false)
      expect(isGitAllowed('cat `git push`')).toBe(false)
      expect(isGitAllowed('$(echo git) push')).toBe(false)
      expect(isGitAllowed('`echo git` push')).toBe(false)
      expect(isGitAllowed('git $(echo push)')).toBe(false)
      expect(isGitAllowed('git status $(echo --output=/tmp/x)')).toBe(false)
      expect(isGitAllowed('echo "$(git push"')).toBe(false)
    })

    test('isGitAllowed still allows harmless substitutions', () => {
      expect(isGitAllowed('echo $(ls)')).toBe(true)
      expect(isGitAllowed('latest=$(git log -1 --format=%H); echo $latest')).toBe(true)
    })

    test('writesStayWithin inspects substitutions', () => {
      expect(writesStayWithin('echo hi > $(rm /etc/x)', {}, '/project')).toBe(false)
      expect(writesStayWithin('echo $(rm /etc/x)', {}, '/project')).toBe(false)
      expect(writesStayWithin('rm $(echo x)', {}, '/project')).toBe(true)
      expect(writesStayWithin('cd $(echo /etc) && rm x', {}, '/project')).toBe(false)
    })
  })

  describe('H3: wrapper and keyword bypasses', () => {
    const bypasses = [
      'env git push',
      'env -i FOO=bar git push',
      'command git push',
      '{ git push; }',
      'if true; then git push; fi',
      'while true; do git push; done',
      'git\\ push',
      'eval "git push"',
      'eval git push',
      'xargs git push',
      'find . -exec git push \\;',
      'find . -execdir git push \\;',
      'exec git push',
      'nohup git push',
      'time git push',
      'timeout 5 git push',
      'timeout -s KILL 5 git push',
      'nice -n 10 git push',
      'stdbuf -oL git push',
      'sudo git push',
      'sudo -u root git push',
      'doas git push',
      'busybox sh -c "git push"',
      'echo "git push" | sh',
      'printf "git push" | bash',
      'bash <<< "git push"',
      'env -S "git push"',
    ]
    for (const cmd of bypasses) {
      test(`${cmd} is forbidden and not git-allowed`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('forbidden')
        expect(isGitAllowed(cmd)).toBe(false)
      })
    }

    test('variable-expanded command names are dynamic', () => {
      expect(classifyShellCommand('g=git; $g push').tier).not.toBe('readonly')
      expect(isGitAllowed('g=git; $g push')).toBe(false)
      expect(isGitAllowed('$GIT status')).toBe(false)
    })

    test('shells fed by pipe/heredoc/herestring are never readonly and not git-allowed', () => {
      expect(classifyShellCommand('echo "rm -rf /" | sh').tier).toBe('forbidden')
      expect(classifyShellCommand('bash <<< "rm -rf /"').tier).toBe('forbidden')
      expect(classifyShellCommand('echo ls | sh').tier).toBe('normal')
      expect(classifyShellCommand('cat script | zsh').tier).toBe('normal')
      expect(classifyShellCommand('bash < script').tier).toBe('normal')
      expect(classifyShellCommand('bash -s').tier).toBe('normal')
      expect(classifyShellCommand('sh <<EOF\ngit push\nEOF').tier).toBe('forbidden')
      for (const cmd of ['echo ls | sh', 'cat script | zsh', 'bash < script', 'bash -s', 'echo x | sudo sh']) {
        expect(isGitAllowed(cmd)).toBe(false)
      }
    })

    test('program-executing tools are no longer readonly', () => {
      expect(classifyShellCommand(`awk 'BEGIN{system("git push")}'`).tier).toBe('normal')
      expect(classifyShellCommand('less +!cmd file').tier).toBe('normal')
      expect(classifyShellCommand('more file').tier).toBe('normal')
      expect(classifyShellCommand('env').tier).toBe('normal')
    })

    test('wrappers around readonly commands', () => {
      expect(classifyShellCommand('env ls').tier).toBe('readonly')
      expect(classifyShellCommand('command ls').tier).toBe('readonly')
      expect(classifyShellCommand('command -v git').tier).toBe('readonly')
      expect(isGitAllowed('command -v git')).toBe(true)
      expect(classifyShellCommand('{ ls; cat f; }').tier).toBe('readonly')
      expect(classifyShellCommand('if ls; then echo ok; fi').tier).toBe('readonly')
      expect(classifyShellCommand('sudo ls').tier).toBe('normal')
      expect(classifyShellCommand('timeout 5 ls').tier).toBe('normal')
      expect(classifyShellCommand('find . | xargs grep foo').tier).toBe('normal')
      expect(isGitAllowed('timeout 5 git status')).toBe(true)
      expect(isGitAllowed('eval "git status"')).toBe(true)
      expect(isGitAllowed('bash -c "git status"')).toBe(true)
      expect(isGitAllowed('find . | xargs grep foo')).toBe(true)
    })

    test('wrappers propagate mass-destructive and forbidden', () => {
      expect(classifyShellCommand('sudo rm -rf dir').tier).toBe('mass-destructive')
      expect(classifyShellCommand('env rm -rf /usr').tier).toBe('forbidden')
      expect(classifyShellCommand("find . | xargs -I{} sh -c 'rm -rf {}'").tier).toBe('mass-destructive')
      expect(classifyShellCommand('nohup timeout 5 nice sudo rm -rf /').tier).toBe('forbidden')
    })

    test('writesStayWithin sees through wrappers and scripts', () => {
      expect(writesStayWithin('sudo rm /etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('env rm /etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('bash -c "rm /etc/x"', {}, '/project')).toBe(false)
      expect(writesStayWithin('eval "rm /etc/x"', {}, '/project')).toBe(false)
      expect(writesStayWithin('find . -exec rm /etc/x \\;', {}, '/project')).toBe(false)
      expect(writesStayWithin('ls | xargs rm -f', {}, '/project')).toBe(true)
      expect(writesStayWithin('sudo rm x', {}, '/project')).toBe(true)
    })
  })

  describe('M3: writesStayWithin output paths', () => {
    test('>| is a write to its target', () => {
      expect(writesStayWithin('echo x >| /etc/passwd', {}, '/project')).toBe(false)
      expect(writesStayWithin('echo x >| out', {}, '/project')).toBe(true)
    })

    test('/dev/null allowance is an exact match', () => {
      expect(writesStayWithin('echo x > /dev/null', {}, '/project')).toBe(true)
      expect(writesStayWithin('echo x > /dev/nullx', {}, '/project')).toBe(false)
      expect(writesStayWithin('echo x > /dev/null/../sda', {}, '/project')).toBe(false)
    })

    test('command output flags are checked', () => {
      expect(writesStayWithin('dd if=a of=/etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('dd if=a of=out.img', {}, '/project')).toBe(true)
      expect(writesStayWithin('curl -o /etc/x http://x', {}, '/project')).toBe(false)
      expect(writesStayWithin('curl --output=/etc/x http://x', {}, '/project')).toBe(false)
      expect(writesStayWithin('curl -o out.txt http://x', {}, '/project')).toBe(true)
      expect(writesStayWithin('wget -O /etc/x http://x', {}, '/project')).toBe(false)
      expect(writesStayWithin('wget -P /etc http://x', {}, '/project')).toBe(false)
      expect(writesStayWithin('find . -fprint /etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('find . -fprint0 /etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('find . -fls /etc/x', {}, '/project')).toBe(false)
      expect(writesStayWithin('echo x | tee /etc/x', {}, '/project')).toBe(false)
    })

    test('sed -i targets', () => {
      expect(writesStayWithin("sed -i 's/a/b/' /etc/x", {}, '/project')).toBe(false)
      expect(writesStayWithin("sed -i -e 's/a/b/' /etc/x", {}, '/project')).toBe(false)
      expect(writesStayWithin("sed --in-place 's/a/b/' /etc/x", {}, '/project')).toBe(false)
      expect(writesStayWithin("sed -i 's/a/b/' file", {}, '/project')).toBe(true)
      expect(writesStayWithin("sed 's/a/b/' /etc/x", {}, '/project')).toBe(true)
    })

    test('tar and unzip extraction / archive targets', () => {
      expect(writesStayWithin('tar -xzf a.tgz -C /etc', {}, '/project')).toBe(false)
      expect(writesStayWithin('tar --extract -f a.tgz --directory=/etc', {}, '/project')).toBe(false)
      expect(writesStayWithin('cd / && tar -xzf a.tgz', {}, '/project')).toBe(false)
      expect(writesStayWithin('tar -xzf a.tgz', {}, '/project')).toBe(true)
      expect(writesStayWithin('tar -czf /etc/x.tgz .', {}, '/project')).toBe(false)
      expect(writesStayWithin('tar czf /etc/x.tgz .', {}, '/project')).toBe(false)
      expect(writesStayWithin('tar -czf out.tgz .', {}, '/project')).toBe(true)
      expect(writesStayWithin('tar -tzf /etc/x.tgz', {}, '/project')).toBe(true)
      expect(writesStayWithin('unzip a.zip -d /etc', {}, '/project')).toBe(false)
      expect(writesStayWithin('cd /usr && unzip a.zip', {}, '/project')).toBe(false)
      expect(writesStayWithin('unzip a.zip', {}, '/project')).toBe(true)
    })
  })

  describe('M4: git global options and dangerous environment', () => {
    for (const cmd of [
      'git --paginate status', 'git -p status', 'git --exec-path=/tmp status',
      'git --exec-path /tmp status', 'git -c core.pager=sh status', 'git --config-env=core.pager=X status',
    ]) {
      test(`${cmd} is forbidden and not git-allowed`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('forbidden')
        expect(isGitAllowed(cmd)).toBe(false)
      })
    }

    test('git log -p and --no-pager stay readonly', () => {
      expect(classifyShellCommand('git log -p').tier).toBe('readonly')
      expect(isGitAllowed('git --no-pager log')).toBe(true)
    })

    const dangerousEnv = [
      'PAGER', 'GIT_PAGER', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_CONFIG_PARAMETERS',
      'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PATH',
    ]
    for (const v of dangerousEnv) {
      test(`${v}=x git status is forbidden`, () => {
        const result = classifyShellCommand(`${v}=x git status`)
        expect(result.tier).toBe('forbidden')
        expect(result.reason).toBeTruthy()
        expect(isGitAllowed(`${v}=x git status`)).toBe(false)
      })
    }

    test('dangerous env through wrappers still reaches git', () => {
      expect(classifyShellCommand('env PAGER=x git status').tier).toBe('forbidden')
      expect(classifyShellCommand('PAGER=x sudo git status').tier).toBe('forbidden')
      expect(classifyShellCommand('PAGER=x bash -c "git status"').tier).toBe('forbidden')
      expect(isGitAllowed('env PAGER=x git status')).toBe(false)
    })

    test('env prefix on non-git or benign vars is not forbidden', () => {
      expect(classifyShellCommand('PAGER=x ls').tier).toBe('normal')
      expect(classifyShellCommand('FOO=bar git status').tier).toBe('normal')
      expect(classifyShellCommand('FOO=bar git push').tier).toBe('forbidden')
      expect(isGitAllowed('FOO=bar git status')).toBe(true)
    })
  })

  describe('M5: shell -c unwrapping', () => {
    for (const cmd of [
      'bash -xc "rm -rf /"', 'sh -ec "rm -rf /"', 'zsh -o pipefail -c "rm -rf /"', 'bash -- -c "rm -rf /"',
      "bash -c'rm -rf /'", 'dash -c "rm -rf /"', 'ksh -c "rm -rf /"', 'fish -c "rm -rf /"', 'ash -c "rm -rf /"',
      'busybox sh -c "rm -rf /"', 'bash -lc "rm -rf /"', 'bash -l -c "rm -rf /"', '/bin/bash -c "rm -rf /"',
      'fish --command="rm -rf /"',
    ]) {
      test(`${cmd} is forbidden`, () => {
        expect(classifyShellCommand(cmd).tier).toBe('forbidden')
      })
    }

    test('shell -c with readonly script is readonly; bare shells are normal', () => {
      expect(classifyShellCommand('bash -c ls').tier).toBe('readonly')
      expect(classifyShellCommand('bash -c').tier).toBe('normal')
      expect(classifyShellCommand('bash script.sh').tier).toBe('normal')
      expect(classifyShellCommand('cat x | bash -c ls').tier).toBe('normal')
      expect(isGitAllowed('bash -c')).toBe(false)
      expect(isGitAllowed('bash script.sh')).toBe(true)
    })
  })

  describe('M8: filesystem and device destruction', () => {
    for (const cmd of ['mkfs.ext4 /dev/sda1', 'mkfs /dev/sda', 'wipefs -a /dev/sda', 'shred /dev/sda', 'shred -n 3 /dev/nvme0n1', 'sudo mkfs.xfs /dev/sdb']) {
      test(`${cmd} is forbidden`, () => {
        const result = classifyShellCommand(cmd)
        expect(result.tier).toBe('forbidden')
        expect(result.reason).toBeTruthy()
      })
    }

    test('shred on a regular file is normal', () => {
      expect(classifyShellCommand('shred file.txt').tier).toBe('normal')
    })
  })

  describe('L8: find -exec recursion', () => {
    test('find -exec through a shell wrapper is mass-destructive', () => {
      expect(classifyShellCommand("find . -exec sh -c 'rm -rf {}' \\;").tier).toBe('mass-destructive')
      expect(classifyShellCommand("find . -exec sudo rm -rf {} +").tier).toBe('mass-destructive')
      expect(classifyShellCommand("find . -exec rm -rf {} +").tier).toBe('mass-destructive')
    })

    test('find -exec with forbidden inner command is forbidden', () => {
      expect(classifyShellCommand("find . -exec sh -c 'rm -rf /usr' \\;").tier).toBe('forbidden')
      expect(classifyShellCommand('find . -ok git push \\;').tier).toBe('forbidden')
    })

    test('find -exec with benign command is normal, plain find is readonly', () => {
      expect(classifyShellCommand('find . -exec cat {} \\;').tier).toBe('normal')
      expect(classifyShellCommand('find . -name x').tier).toBe('readonly')
    })
  })
})
