# Share Modal Implementation Checklist

Purpose: track implementation of guest invite sharing from organizer modal (native share, QR, and channel fallbacks).

## Scope
- Allow organizer to share invite via native mobile share sheet when available.
- Support WhatsApp/email/copy/download fallbacks.
- Include QR + link in share experience.

## Checklist
- [ ] Define final invite copy template: `Scan the QR code or use this link: <link>`.
- [ ] Decide brand fields in message (event name, organizer name, optional upload deadline).
- [ ] Replace external QR service usage with in-app QR generation (client or API-generated PNG/SVG).
- [ ] Add utility to generate QR as downloadable image blob/file.
- [ ] Add utility to build share text from `eventName + guestUrl`.
- [ ] Add utility `canNativeShare()` for `navigator.share` support.
- [ ] Add utility `canNativeShareFiles()` for `navigator.canShare({ files })` support.
- [ ] Add modal action: `Share with apps` (primary).
- [ ] Implement primary flow: call `navigator.share` with text + URL.
- [ ] Implement enhanced primary flow: include QR file when file sharing is supported.
- [ ] Add fallback button: `WhatsApp`.
- [ ] Implement WhatsApp deep link with encoded invite text + link.
- [ ] Add fallback button: `Email`.
- [ ] Implement `mailto:` with subject + body containing invite text + link.
- [ ] Add fallback button: `Copy invite`.
- [ ] Implement copy of full invite text (not just raw URL).
- [ ] Keep inline URL copy icon button in modal.
- [ ] Add fallback button: `Download QR`.
- [ ] Ensure QR is always visible in modal.
- [ ] Add user feedback toasts for success/failure on each action.
- [ ] Add loading/disabled states for share buttons during async actions.
- [ ] Add mobile-first layout for action buttons.
- [ ] Add desktop layout polish for spacing/alignment.
- [ ] Add analytics events: `share_attempt`, `share_success`, `share_fallback_used`.
- [ ] Add guardrails for missing/invalid `guestUrl`.
- [ ] Add accessibility labels for icon-only actions.
- [ ] Verify keyboard focus and Escape behavior in modal.
- [ ] Run iOS Safari validation for native share behavior.
- [ ] Run Android Chrome validation for native share behavior.
- [ ] Run desktop Chrome/Firefox validation for fallback behavior.
- [ ] Add unit tests for share text and URL encoding helpers.
- [ ] Add integration test for modal actions rendered by capability.
- [ ] Update product/docs with supported share behaviors and limits.
- [ ] Update `docs/implementation-status.md` with completion status.

## Acceptance Criteria
- [ ] One-tap `Share with apps` works on supported mobile browsers.
- [ ] If native share is unsupported, fallback actions still allow immediate sharing.
- [ ] Invite text + link can be shared reliably via WhatsApp/email.
- [ ] QR can be downloaded and manually forwarded when needed.
- [ ] No regressions in existing organizer share modal behavior.

