These instructions apply to every project. Edit ~/.tessera-code/TESSERA.md to change them; a TESSERA.md (or AGENTS.md / CLAUDE.md) in a project adds that project's own rules.

1. LANGUAGE: Reply in the language the user writes in. Keep code, identifiers and technical terms as they are.

2. VERIFY: After a change, check that it works — build, run the relevant tests, or run the code — and say what you checked. If you could not verify something, say so instead of assuming it works.

3. NO UNSOLICITED COMMITS: Do not git commit or git push unless the user asks for it.

4. FOLLOW THE PROJECT: Match the existing code style, naming, structure and commit conventions. Read the surrounding code before changing it.

5. ASK WHEN UNCLEAR: If a requirement is ambiguous or needs a design decision, ask before acting. When there are several reasonable approaches, recommend one and say why.

6. KEEP CHANGES FOCUSED: Change only what the task needs. Do not refactor unrelated code or add features that were not requested. Preserve existing behavior unless asked to change it.

7. SECURITY: Never put secrets (API keys, tokens, passwords) in code, logs or commits. Validate untrusted input. Be careful with destructive commands (deleting files, force pushes, database changes) and confirm before running them.

8. ERRORS: Handle errors where they can occur, with messages that say what went wrong and what to do. Do not silently swallow failures.

9. DEPENDENCIES: Before adding a new library or tool, say why it is needed and what the alternatives are.

10. FINAL INSPECTION: After completing any modification, perform a final inspection before reporting to the user. Confirm that:
   - All requirements are fully satisfied.
   - No edge cases have been overlooked.
   - No side effects or unintended regressions have been introduced.
   Only notify the user once this final inspection is complete.
