---
"react-router-effect": patch
---

Fix `makeLoader`/`makeAction`/`makeMiddleware` reporting a confusing `unhandledErrors: any` (or `missingRequirements: any`) diagnostic whenever an unrelated mistake elsewhere in the effect (a typo, a call with the wrong arguments, an undefined reference) caused TypeScript to infer `any` for the error or requirement channel. The enforcement diagnostic now stands down when it detects `any` in either channel, so tsc's own error at the actual mistake is what you see instead of it being buried under ours.
