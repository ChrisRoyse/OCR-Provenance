---
description: Commit and push all changes to the current branch (with validation)
---

You are tasked with committing and pushing all changes in the repository to the remote.

Follow these steps:

1. Check the current git status to understand what changes exist
2. Review the diff of all changes
3. Review recent commit messages to match the repository's commit style
4. Stage all modified and new files
5. **VALIDATE CODE QUALITY** - Run pre-commit validation hooks:
   ```bash
   echo '{"session_id":"pushrepo","tool_input":{"command":"git commit"}}' | python3 .claude/hooks/pre_commit_validation.py
   ```
   - If validation FAILS (exit code 2):
     - Show validation errors to user
     - List all files with critical issues
     - Provide line numbers and suggestions
     - **STOP - DO NOT COMMIT OR PUSH**
     - Ask user to fix issues or confirm override
   - If validation PASSES (exit code 0):
     - Continue to commit step
     - Mention validation passed in output
6. Create a comprehensive commit message that:
   - Uses a conventional commit prefix (feat:, fix:, docs:, refactor:, etc.)
   - Includes a clear, descriptive summary
   - Lists key changes in bullet points
   - Ends with the Claude Code signature:
     ```
     🤖 Generated with [Claude Code](https://claude.com/claude-code)

     Co-Authored-By: Claude <noreply@anthropic.com>
     ```
7. Commit the changes with the message
8. Push to the remote repository on the current branch
9. Verify the push was successful by checking git status

Important:
- DO NOT commit files that likely contain secrets (.env, credentials.json, etc.)
- DO NOT commit or push if validation fails (unless user explicitly overrides)
- Analyze changes carefully to create an accurate commit message
- Follow the repository's existing commit message conventions
- Always push to the current branch (use `git push -u origin <current-branch>`)
- Validation checks for: silent failures, broad exceptions, missing error propagation

Validation Rules Enforced:
- **Silent Failures**: Exception handlers must log before returning empty values
- **Critical Errors**: GPU/OOM/CUDA errors must be propagated, not swallowed
- **Exception Handling**: Prefer specific exception types over broad catches
- **Error Messages**: Must be clear and actionable, not generic

Override Option:
- If user explicitly requests to skip validation, you may use `git commit --no-verify`
- However, strongly recommend fixing issues instead
- Document why validation was skipped in commit message
