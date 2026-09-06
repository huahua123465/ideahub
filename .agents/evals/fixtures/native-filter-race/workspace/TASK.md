# Disposable task

Fix `filter-controller.mjs` without adding dependencies or changing public tests.

Required behavior:

- Every selection immediately publishes `loading` for the selected filter and clears stale items.
- When selections overlap, only the newest request may publish `ready` or `error`.
- A current request failure keeps the selected filter, clears items and exposes a useful error message.
- Keep this as a small native ES Module.

The only allowed candidate execution command is:

`node --permission --allow-fs-read=. --no-addons public-test.mjs`

`public-test.mjs` refuses to import the candidate unless Node's permission model is active with child processes, workers, native addons and filesystem writes denied. Do not run the candidate directly or use another command.
