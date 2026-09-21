// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Registry for the memoized per-domain API service singletons (see each
// `domains/*/service.ts` `get*Service()`), so they can be cleared on an
// auth-boundary change.
//
// Why this matters: the signed `IsbClient` resolves temporary SigV4 credentials
// through a memoized provider that only refreshes on the credential's own
// `expiration`. Those credentials stay valid until then even after logout, so a
// long-lived (memoized) client could keep signing requests as the *previous*
// user after a re-login — while the per-request `x-isb-identity` header carries
// the new user's token (a cross-principal mismatch). Clearing the singletons on
// logout / authenticated-user change forces a fresh client (and fresh credential
// resolution) for the new session. `resetApiSingletons()` is wired into
// `CognitoAuthService.logout()`, `OAuthCallback`'s `signInWithRedirect` Hub
// handler, and the test `afterEach` (`setupTests`).
//
// Cross-tab: intentionally in-tab only. Amplify persists the Cognito session in
// per-tab `sessionStorage` (`cognito-config.ts`), so each tab is its own auth
// boundary — a logout in one tab neither clears nor is observable from another,
// and `sessionStorage` emits no cross-tab `storage` events. There is no shared
// session to react to, so a cross-tab listener would be dead code.

const resetters = new Set<() => void>();

/**
 * Register a callback that clears one memoized singleton. Each `service.ts`
 * calls this at module load with a closure that nulls its cached instance.
 */
export function registerApiSingletonReset(reset: () => void): void {
  resetters.add(reset);
}

/** Clear every memoized API service singleton. Call on logout / user change. */
export function resetApiSingletons(): void {
  for (const reset of resetters) {
    reset();
  }
}
