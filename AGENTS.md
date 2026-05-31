# Do

- Check the diff before committing changes.
- Commit only changes that are directly related to your work.
- Ignore unrelated changes in the worktree; they may have been made by another agent or the user.
- Preserve browser-local image processing for the web app.
- Keep crop points in original image coordinates.
- Keep crop point order as top-left, top-right, bottom-right, bottom-left.
- Keep preview and export behavior in sync.
- Use pnpm from the repo root for workspace commands.
- Run focused verification for the files or behavior you changed.

# Don't

- Do not commit unrelated worktree changes.
- Do not revert or overwrite unrelated changes made by another agent or the user.
- Do not run the dev server.
- Do not move crop coordinate systems unless explicitly requested.
- Do not introduce server-side image processing unless explicitly requested.
- Do not make unrelated refactors, dependency churn, or styling rewrites during narrow fixes.
