# Agents working on this repo

- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.
- UI/design: Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- No screen scrolls, down or sideways. Content that may not fit goes in a `data-fit` box (see `docs/fit.js`); `scripts/e2e.js` checks every screen with `noScroll`.
- Tests: `node docs/logic.test.js`, `node scripts/worker-test.mjs`, and `node scripts/mock-server.js & node scripts/e2e.js` (restart the mock server before each e2e run; it keeps state).
