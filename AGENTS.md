# Agents working on this repo

- Make the best decision that will elevate all three: the user experience (UX), developer experience (DX), and agent experience (AX) always, without breaking anything.
- UI/design: Cut taglines, helper text and secondary labels. If a screen needs them to make sense, fix the layout.
- Look: an iPhone app. Each screen opens on the farm picture (`docs/farm.svg`) with its title; glass only on what floats (tab bar, top buttons, the picture's card, the bottom action). Pages scroll down, never sideways; `scripts/e2e.js` checks every screen with `noScroll`.
- Tests: `node docs/logic.test.js`, `node scripts/worker-test.mjs`, and `node scripts/mock-server.js & node scripts/e2e.js` (restart the mock server before each e2e run; it keeps state).
